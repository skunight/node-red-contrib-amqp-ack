import * as amqp from "amqp-ts";
import * as querystring from 'querystring';

const fs = require("fs");
const getos = require("getos");
const util = require("util");
const getOsPromise = util.promisify(getos);

var osDistroLowerCase;
const defaultCaFileLocation = "/etc/ssl/certs/ca-certificates.crt";

module.exports = function(RED) {
  "use strict";

  const exchangeTypes = ["direct", "fanout", "headers", "topic"];

  function initialize(node) {
    if (node.server) {
      node.status({fill: "green", shape: "ring", text: "connecting"});

      // Get the OS information before connecting initially
      getOsPromise().then(function(result) {
        // windows and macos don't have 'dist'
        const os = result.dist ? result.dist : result.os;

        osDistroLowerCase = os.toLowerCase();
        return node.server.claimConnection();
	    }, function(err) {
		    console.error(err);
      })
      .then(function () {
        // node.ioType is a string with the following meaning:
        // "0": direct exchange
        // "1": fanout exchange
        // "2": headers exchange
        // "3": topic exchange
        // "4": queue
        if (node.ioType === "4") {
          node.src =  node.server.connection.declareQueue(node.ioName);
          if (node.server.prefetch) {
            node.src.prefetch(Number(node.server.prefetchvalue));
          }
        } else {
          node.src =  node.server.connection.declareExchange(node.ioName, exchangeTypes[node.ioType]);
        }
        node.src.initialized.then(function () {
          node.status({fill: "green", shape: "dot", text: "connected"});
          // execute node specific initialization
          node.initialize();
        }).catch(function (err) {
          node.status({fill: "red", shape: "dot", text: "connect error"});
          node.error("AMQP " + node.amqpType + " node connect error: " + err.message);
        });
      }).catch(function (err) {
          node.status({fill: "red", shape: "dot", text: "connect error"});
          node.error("AMQP " + node.amqpType + " node connect error: " + err.message);
      });

      node.on("close", function() {
        node.src.close().then(function () {
          node.server.freeConnection();
          node.status({fill: "red", shape: "ring", text: "disconnected"});
        }).catch(function (err) {
          node.server.freeConnection();
          node.status({fill: "red", shape: "dot", text: "disconnect error"});
          node.error("AMQP " + node.amqpType + " node disconnect error: " + err.message);
        });
      });
    } else {
      node.status({fill: "red", shape: "dot", text: "error"});
      node.error("AMQP " + node.amqpType + " error: missing AMQP server configuration");
    }
  }


//
//-- AMQP IN ------------------------------------------------------------------
//
  function AmqpIn(n) {
    var node = this;
    RED.nodes.createNode(node, n);

    node.source = n.source;
    node.topic = n.topic;
    node.ioType = n.iotype;
    node.ioName = n.ioname;
    node.server = RED.nodes.getNode(n.server);

    // set amqp node type initialization parameters
    node.amqpType = "input";
    node.src = null;
    node.context().flow.set("amqpobjectsacks", new Map());

    // node specific initialization code
    node.initialize = function () {
      function Consumeack(msg) {
        node.send({
          topic: node.topic || msg.fields.routingKey,
          payload: msg.getContent(),
          amqpfields: msg.fields
        });
        if (node.server.prefetchack) {
          setTimeout( function () {
            try {
              msg.ack();
            } catch (ein) {
              node.error("No ack send in last message");
            }
         }, Number(node.server.prefetchvalueack));
        } else {
          var localamqpobjectsacks = node.context().flow.get("amqpobjectsacks");
          localamqpobjectsacks.set(msg.fields.deliveryTag, msg);
          node.context().flow.set("amqpobjectsacks", localamqpobjectsacks);
        };
      }
      function Consumenack(msg) {
        node.send({
          topic: node.topic || msg.fields.routingKey,
          payload: msg.getContent(),
          amqpMessage: msg
        });
      }
      if (node.server.prefetch) {
        node.src.activateConsumer(Consumeack, {noAck: (!node.server.prefetch)}).then(function () {
          node.status({fill: "green", shape: "dot", text: "connected"});
        }).catch(function (e) {
          node.status({fill: "red", shape: "dot", text: "error"});
          node.error("AMQP input error: " + e.message);
        });
      } else {
        node.src.activateConsumer(Consumenack, {noAck: (!node.server.prefetch)}).then(function () {
          node.status({fill: "green", shape: "dot", text: "connected"});
        }).catch(function (e) {
          node.status({fill: "red", shape: "dot", text: "error"});
          node.error("AMQP input error: " + e.message);
        });
      }
  };
    if (!node.ioName) {
      node.on("input", function(msg){
        node.ioName = msg.readFrom;
        initialize(node);
      });
    } else {
      initialize(node);
    }
}
//
//-- AMQP ACK -----------------------------------------------------------------
//
function AmqpAck(n) {
  var node = this;
  RED.nodes.createNode(node, n);

  node.source = n.source;
  node.topic = n.topic;
  node.ioType = n.iotype;
  node.ioName = n.ioname;
  node.nack = n.nack;
  node.reject = n.reject
  node.server = RED.nodes.getNode(n.server);

  // set amqp node type initialization parameters
  node.amqpType = "input";
  node.src = null;
  node.reconnection = false;

  // node specific initialization code
  node.initialize = function () {
    node.on("input", function (msg) {
      if (msg.amqpfields) {
        var localamqpobjectsacks = node.context().flow.get("amqpobjectsacks");
        var amqpfindack = localamqpobjectsacks.get(msg.amqpfields.deliveryTag);
        if (amqpfindack) {
          try {
            if(node.reject) {
              amqpfindack.reject();
            } else {
              if (!node.nack) {
                amqpfindack.ack();
              } else {
                amqpfindack.nack();
              }
            }
          } catch (e) {
            if (e.message === "Channel closed" && !node.reconnection) {
              // wait reconnection to reset
              node.reconnection = true;
              setTimeout(() => {
                node.context().flow.set("amqpobjectsacks", new Map());
                node.src.recover();
                node.reconnection = false;  }, 30000);
              node.error("Amqp error (reset connection): " + e.message);
            } else {
              node.error("Amqp error: " + e.message);
            }
          }
        }
        localamqpobjectsacks.delete(msg.amqpfields.deliveryTag);
        node.context().flow.set("amqpobjectsacks", localamqpobjectsacks);
        node.send(msg);
      } else {
        node.warn({
          error: "msg without amqpfields per ack",
          msg: msg
        });
      }
    });
  };

  initialize(node);
}

//
//-- AMQP OUT -----------------------------------------------------------------
//
  function AmqpOut(n) {
    var node = this;
    RED.nodes.createNode(node, n);

    node.source = n.source;
    node.topic = n.routingkey;
    node.ioType = n.iotype;
    node.ioName = n.ioname;
    node.server = RED.nodes.getNode(n.server);

    // set amqp node type initialization parameters
    node.amqpType = "output";
    node.src = null;

    // node specific initialization code
    node.initialize = function () {
      node.on("input", function (msg) {
        var message;
        if (msg.payload) {
          message = new amqp.Message(msg.payload, msg.options);
        } else {
          message = new amqp.Message(msg);
        }
        message.sendTo(node.src, node.topic || msg.topic);
      });
    };

    initialize(node);
  }


//
//-- AMQP SERVER --------------------------------------------------------------
//
  function AmqpServer(n) {
    var node = this;
    RED.nodes.createNode(node, n);

    // Store local copies of the node configuration (as defined in the .html)
    node.host = n.host || "localhost";
    node.port = n.port || "5672";
    node.vhost = n.vhost;
    node.keepAlive = n.keepalive;
    node.useTls = n.usetls;
    node.useTopology = n.usetopology;
    node.topology = n.topology;
    node.useca = n.useca;
	  node.ca = n.ca || null;

    node.clientCount = 0;
    node.connectionPromise = null;
    node.connection = null;

    node.prefetch = n.prefetch;
    node.prefetchvalue = n.prefetchvalue;
    node.prefetchack = n.prefetchack;
    node.prefetchvalueack = n.prefetchvalueack;

    node.claimConnection = function() {
      if (node.clientCount === 0) {
        // Create the connection url for the AMQP server
        var urlType = node.useTls ? "amqps://" : "amqp://";
        var credentials = "";
        if (node.credentials.user) {
          credentials = querystring.escape(node.credentials.user) + ":" + querystring.escape(node.credentials.password) + "@";
        }
        var urlLocation = node.host + ":" + node.port;
        if (node.vhost) {
          urlLocation += "/" + node.vhost;
        }
        if (node.keepAlive) {
          urlLocation += "?heartbeat=" + node.keepAlive;
        }

		var opt = {
			ca: []
		};

		// We only need to OS check for TLS connections
        if (node.useTls) {
            if (node.useca) {
                node.log("Using custom CA file: " + node.ca);
                opt.ca = fs.readFileSync(node.ca);
            } else {

                // FUTURE: This block should be locating the proper ca-cert for this distro.
                if (osDistroLowerCase.includes("ubuntu") || osDistroLowerCase.includes("alpine")) {
                    node.log("Ubuntu or Alpine OS detected, using CA file: " + defaultCaFileLocation);
                    opt.ca = fs.readFileSync(defaultCaFileLocation);
                } else { // Alternate OS's would need else-if blocks here
                    node.log("Unable to determine the local distro, defaulting to CA file: " + defaultCaFileLocation);
                    opt.ca = fs.readFileSync(defaultCaFileLocation);
                }

            }
        } else {
            node.log("Initializing in-clear AMQP connection");
        }
        node.connection = new amqp.Connection(urlType + credentials + urlLocation, opt);

		// Wait for initialization
        node.connectionPromise = node.connection.initialized.then(function () {
          node.log("Connected to AMQP server " + urlType + urlLocation);
        }).catch(function (e) {
          node.error("AMQP-SERVER error: " + e.message);
        });

        // Create topology
        if (node.useTopology) {
          try {
            var topology = JSON.parse(node.topology);
          } catch (e) {
            node.error("AMQP-SERVER error creating topology: " + e.message);
          }
          node.connectionPromise = node.connection.declareTopology(topology).catch(function (e) {
            node.error("AMQP-SERVER error creating topology: " + e.message);
          });
        }
      }
      node.clientCount++;


      return node.connectionPromise;
    };

    node.freeConnection = function() {
      node.clientCount--;

      if (node.clientCount === 0) {
        node.connection.close().then(function () {
          node.connection = null;
          node.connectionPromise = null;
          node.log("AMQP server connection " + node.host + " closed");
        }).catch(function (e) {
          node.error("AMQP-SERVER error closing connection: " + e.message);
        });
      }
    };
  }

  // Register the node by name. This must be called before overriding any of the
  // Node functions.
  RED.nodes.registerType("amqp in", AmqpIn);
  RED.nodes.registerType("amqp ack", AmqpAck);
  RED.nodes.registerType("amqp out", AmqpOut);
  RED.nodes.registerType("amqp-server", AmqpServer, {
    credentials: {
      user: {type: "text"},
      password: {type: "password"}
    }
  });
};
