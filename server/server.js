/**
 * @file server.h
 * @brief Server for WebSocket<->SSH and serve clients file
 * @author Maxime BURRI
 */

/* Requires */
var config = require('./config');
var express = require('express');
var app = express();
var https = require('https');
var fs = require('fs');
var socketio = require('socket.io');
var util = require('util');
var shellescape = require('shell-escape');
var path = require('path');
var colors = require('colors'); // Log colors

var Client = require('./Client.js');
var ClientSSH = require('ssh2').Client;

// Construction of objectsOperations (operations rooter)
var ObjectController = require('./objects/ObjectController.js');
var JobObject = require('./objects/JobObject.js');
var JobsObject = require('./objects/JobsObject.js');
var FilesObject = require('./objects/FilesObject.js');
var FileObject = require('./objects/FileObject.js');
var PartitionsObject = require('./objects/PartitionsObject.js');
var LicensesObject = require('./objects/LicensesObject.js');
var ModulesObject = require('./objects/ModulesObject.js');
var ModuleObject = require('./objects/ModuleObject.js');
var ConfigurationObject = require('./objects/ConfigurationObject.js');
var SubmissionScriptObject = require('./objects/SubmissionScriptObject.js');
var UserObject = require('./objects/UserObject.js');
var ClusterObject = require('./objects/ClusterObject.js');

var objectsOperations = new ObjectController({
    "job" : new JobObject(),
    "jobs" : new JobsObject(),
    "files" : new FilesObject(),
    "file" : new FileObject(),
    "partitions" : new PartitionsObject(),
    "licenses" : new LicensesObject(),
    "modules" : new ModulesObject(),
    "module" : new ModuleObject(),
    "configuration" : new ConfigurationObject(),
    "submissionScript" : new SubmissionScriptObject(),
    "user" : new UserObject(),
    "cluster" : new ClusterObject()
});

var optionsServer = {
  key: fs.readFileSync(config.https_server.certs_key_file),
  cert: fs.readFileSync(config.https_server.certs_cert_file)
};
var server = https.createServer(optionsServer, app);

server.listen(config.https_server.port, function() {
	console.log(("Server listening on port " + config.https_server.port).green)
});

/* HTTP server for client files */
if(config.https_server.client_files.serve_files){
    app.use(express.static(__dirname + config.https_server.client_files.folder));
    console.log( "Client files serving ("
                + config.https_server.client_files.folder
                + ")");
}

console.logCopy = console.log.bind(console);
console.log = function(data)
{
    var currentDate = ('[' + new Date().toUTCString() + ']').grey;
    this.logCopy(currentDate, data);
};

var attemptsIpv6Clients = {};
/** Socket IO **/
var io = socketio(server);
io.set('heartbeat interval', 1000);
io.set('heartbeat timeout', 5000);

io.on('connection', function (socket) {
    var ssh = new ClientSSH();
    var client = new Client(ssh, socket);
    var ipv6String = client.ipv6String;
    if(!attemptsIpv6Clients[ipv6String]){
        attemptsIpv6Clients[ipv6String] = {
            attempts : 0,
            banned : false,
            timestampUnban : 0,
            timestampLastAttempt : 0,
        }
    }
    var attemptsClient = attemptsIpv6Clients[ipv6String];
    var connectionClientCallback = undefined;

    console.log("Client::connection "+
            client.toStringDetail());

    sendResponseLogin = function(type, info, success){
        // Check if banned, so send
        if(attemptsClient.attempts >= config.connection.max_attempts_by_ip )
        {
            currentTimestamp = Math.round(new Date().getTime()/1000);
            attemptsClient.banned = true;
            attemptsClient.timestampUnban = currentTimestamp +
                config.connection.time_banned_by_ip ;
            attemptsClient.attempts = 0;
            type = "banned";
        }
        if(attemptsClient.banned){
            if(!info)
                info = {};
            info.banned = true;
            info.timestampUnban = attemptsClient.timestampUnban;
        }

        console.log("Client::login : " + client.toString() +
                    " : " + (success ? type.toString().green :
                               type.toString().red ));
        connectionClientCallback(
            {
                type:type,
                info: info
            });
    };

	// When client want to login
    function login(data, clientCallback){
        connectionClientCallback = clientCallback;
        console.log("Client::login : " + client.toString() +
            " cluster:" + data.cluster.toString().cyan +
            " username:" + data.username.toString().cyan);

        // If already attemps
        if(attemptsClient.banned){
            currentTimestamp = Math.round(new Date().getTime()/1000);
            if(attemptsClient.timestampUnban > currentTimestamp){
                console.log("Client::login : " + client.toString() +
                    " already banned".red );
                sendResponseLogin("banned");
                return;
            }else{
                attemptsClient.banned = false;
                console.log("Client::login : " + client.toString() +
                    " no more banned" );
            }
        }
        attemptsClient.attempts++;

        if(data == undefined){
            sendResponseLogin("bad-parameter");
            return;
        }

        // Check whitelisted
        if( config.connection.accepted_clusters &&
            config.connection.accepted_clusters.indexOf(data.cluster) < 0){
            sendResponseLogin("cluster-rejected");
            return;
        }

		// Remove login
		socket.removeListener('login', login);

		// Try to connect
        try{
            client.params = data;
            ssh.connect({
                host: data.cluster,
                username: data.username,
                password: data.password,
				readyTimeout: config.ssh.timeout, // Max timeout (milliseconds)
            });
            client.params = data;
        }
		// Connection error
		catch(e){
            // Reconnect login function
            socket.on('login', login);
            sendResponseLogin(e.message);
        }
    }

	// When client want to logout
	function logout(data){
		try{
			console.log("Client::logout : " + client.toString().cyan)
            quitClientCloseSSH();

			// Reconnect login function
			socket.on('login', login);
			socket.removeListener('operation', operation);

			// Send log outed
			socket.emit("logout", {type:"NORMAL_LOGOUT"});
		}catch(e){
			console.log(e.message)
		}
	}

	// When the SSH is connected
	function sshConnected(){
		try{
            ssh.ready = true;
            //attemptsClient.attempts--;
            attemptsIpv6Clients[ipv6String] = undefined;

            // Kill old processes tail
            objectsOperations.objects["file"].operations["get"].endAllFilesReadClient(client);

			console.log("SSH::connected : " + client.toString())

			// Add logout
			socket.on('logout', logout);
			socket.on('operation', operation);

			// Emit authenticated
			sendResponseLogin("authenticated", {}, true);
		}catch(e){}
	}

	// When the socket disconnects
	function disconnect(){
		try{
			console.log("Client::disconnected : " + client.toString().cyan)

            quitClientCloseSSH();

			// Reconnect login function
			socket.on('login', login);
			socket.removeListener('operation', operation)

		}catch(e){
			console.log(e.message)
		}
	}

	// When SSh2 error
	function sshError(err){
        // Reconnect login function
        socket.on('login', login);

        // Error in authentication ? Use callback login client
        if(err.level == "client-authentication" || err.level == "client-socket"){
            sendResponseLogin(err.level);
        }
        else{
            // Send error
            socket.emit("error_ssh", {error:err});
            		console.log("Client::login::ssh::error: "+ client.toString()
                        + " " + err.red)
        }

        ssh.end();
	}

	// When receive a operation message
	function operation(operation, clientCallback){
        objectsOperations.makeOperation(client, operation, clientCallback);
    }

    // Quit client (close ssh after quit operations)
    function quitClientCloseSSH(){
        // If ssh ready
        if(ssh.ready){
            objectsOperations.onQuitClient(client,
                // End ssh connection when all operations finished
                function(){
                    console.log('SSH finished, close ssh for ' +
                        client.toString());
                    // End ssh connection
                    ssh.end();
                }
            );
        }
    }

    // Connect events
	ssh.on('ready', sshConnected);
	ssh.on('error', sshError);
    socket.on('login', login);
	socket.on('disconnect', disconnect);
});
