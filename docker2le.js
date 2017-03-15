// USE node.js 7.6 or above

var tls = require('tls');
var Docker = require('dockerode');
//var Queue = require('./queue.js').Queue;
var stream = require('stream');
var fs = require('fs');
//var events = require('events');
//var eventEmitter = require('events').EventEmitter;

var log = function(message){
    console.log('[' + new Date().toISOString() + '] ' + message);
}

/* Use ENV VAR as configuration
{
    "default": {"labels":["myname"], "token":"TOKEN_1"},
    "filters": [
        { "labels":["myname", "tag1"], "filter":["tag1=a", "tag2=1"], "token":"TOKEN_2"},
        { "labels":["myname", "tag2"], "filter":["tag1=b", "tag2=1"], "token":"TOKEN_3"},
    ] 
}
*/
var config = JSON.parse(process.env['DOCKER_LE_CONFIG']); //ENV VAR 


var containerPool = {}; // keep a connection pool of docker api

var leSocket = null; // socket object to Logentries

var docker = new Docker({socketPath: '/var/run/docker.sock'}); // unix socket

var DOCKER_TIME = 1000; // query docker api time interval
var dockerTimer = null;

try{
    connectLE();
}catch(err){
    console.log(err);
}


/*
* 
* Change docker log buffer to json object:
* {
*     time: "unix time in ISO String"
*     log: "log content"
* }
* 
* */
function dockerLogToObj(chunk){
    try{
        var s = chunk.toString();
        return { 
            time: new Date(s.substr(0, 30)).toISOString(),
            log: s.substr(31).trim()
        }
    }catch(err){
    }
}


function connectLE(){
    log('Connecting Logentries...')
    leSocket = tls.connect(443, "data.logentries.com", {}, function () {
        if (leSocket.authorized) {
            leSocket.setEncoding('utf8');
            leSocket.setNoDelay();

            leSocket.ready = true;
            log("Logentries connected!");

            logContainers();

            clearInterval(dockerTimer);
            dockerTimer = setInterval(logContainers, DOCKER_TIME);
        }else{
            log("Logentries failed!");
        }

    });

    // Just reconnect!!!
    leSocket.on('end', function(){
        log('Logentries connection closed! reconnect...');
        connectLE
    });

    leSocket.on('close', function(){
        log('Logentries connection closed! reconnect...');
        connectLE
    });

}

function le_write(token, message){
    if (!leSocket.ready) return;
    leSocket.write(token + ' ' + message + '\n'); 
}

async function logContainers(){
    // get all containers
    var containers = await getContainers();
    for (var i=0; i < containers.length; i++){
        var c = containers[i];

        // stop if already exist in connection pool
        if (containerPool[c.Id]){
            continue;
        }
        var labels = hashTohash(c.Labels); // hash map for label checking
        var logset = []; // logset token list 
        // match any possible label match
        for (var j=0; j < config.filters.length; j++){
            var filter = config.filters[j]
            // if matched, add to the logset
            if (matchLabel(filter.filter, labels)){

                var labelsToLogs = {};
                // include some labels to the log
                for (var k=0; k < filter.labels.length; k++){
                    var key = filter.labels[k];
                    if (c.Labels[key]){
                        labelsToLogs[key] = c.Labels[key]
                    }
                }
                logset.push({ token:filter.token, labels:labelsToLogs});
            }
        }
        // if nothing match, go to the default logset if any
        if (logset.length === 0 && config.default ){
            var labelsToLogs = {};
            for (var j=0; j < config.default.labels.length; j++){
                var key = config.default.labels[j];
                if (c.Labels[key]){
                    labelsToLogs[key] = c.Labels[key]
                }
            }

            logset.push({ token: config.default.token, labels: labelsToLogs});
        }
        
        listenDockerLog({id: c.Id, logset:logset});
    }
    
};


function hashTohash(h){
    var keys = Object.keys(h);
    var o = {};
    for(var i=0; i < keys.length; i++){
        o[keys[i]+'='+h[keys[i]]] = true;
    }
    return o;

}
function matchLabel(f, l){
    for (var i=0; i < f.length; i++){
        if (!l[f[i]]) return false;
    }
    return true;
}

async function getContainers(){
    try {
        var res = await docker.listContainers({});
    }catch(err){
        log(err)
        return []
    }
    return res;
}

function listenDockerLog(info){
    // stop if exists
    if (containerPool[info.id]){
        return;
    }

    var container = docker.getContainer(info.id);
    var logStream = new stream.PassThrough();
    containerPool[info.id] = logStream; // store socket object to the pool
    logStream.info = info; // store info for reference
    logStream.on('data', function(chunk){
        var l = dockerLogToObj(chunk); 
        // add the Labels to the real log object
        for (var i=0; i < this.info.logset.length; i++){
            try{
                var logset = this.info.logset[i];
                // fire the log!
                le_write(logset.token, JSON.stringify(Object.assign(l, logset.labels)));
            }catch(err){
            }
        }
    });

    container.logs({
        follow: true,
        stdout: true,
        stderr: true,
        timestamps: true,
        // unixtime in SEC, very on99!
        since: Math.round(new Date().getTime()/1000), 
    }, function(err, stream){
        if(err) {
            log(err);
            return;
        }

        container.modem.demuxStream(stream, logStream, logStream);
        stream.on('end', function(){
            log('Container "' + logStream.info.id +'" stopped!');
            delete containerPool[logStream.info.id]; // remove socket object from the pool
            logStream.end('!stop!');
        });
        stream.on('close', function(){
            log('Container "' + logStream.info.id +'" stopped!');
            delete containerPool[logStream.info.id];
            logStream.end('!stop!');
        });

    });
}




