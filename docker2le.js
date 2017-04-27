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
var dockerEvtSocket = null; // docker event listener socket

var docker = new Docker({socketPath: '/var/run/docker.sock'}); // unix socket

var LOG_TIME = 5000; // query docker api time interval
var EVENT_TIME = 5000; 
var logTimer = null;
var eventTimer = null;

/* STARTS */
try{
    connectLE();
}catch(err){
    console.log(err);
}

// run GC every hour
setInterval(function(){
    if (global.gc){
        global.gc();
        log("[GC] Done!");
        return;
    }
    log("[GC] no GC, run with --expose-gc ?");

}, 3600000);




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


/*
* 
*  1. keep connected with Logentries TCP api
*  2. keep log the missed containers (in case docker event api disconnected)
*  3. keep connected with docker event api
* 
* */
function connectLE(){
    try{
        if (leSocket.ready) {
            return;
        }
    }catch(err){}

    log('Connecting Logentries...')
    leSocket = tls.connect(443, "data.logentries.com", {}, function () {
        if (leSocket.authorized) {
            leSocket.setEncoding('utf8');
            leSocket.setNoDelay();

            leSocket.ready = true;
            log("Logentries connected!");

            logContainers();
            listenDockerEvent();

            // keep log skipped containers
            clearInterval(logTimer);
            logTimer = setInterval(logContainers, LOG_TIME); 

            // reconnect the docker event API
            clearInterval(eventTimer);
            eventTimer = setInterval(listenDockerEvent, EVENT_TIME);
        }else{
            log("Logentries failed!");
        }

    });

    // Just reconnect!!!
    leSocket.on('error', function(){
        log('Logentries connection error!');
    });

    leSocket.on('close', function(){
        log('Logentries connection closed!');
    });

    leSocket.on('end', function(){
        log('Logentries connection ended! reconnect...');
        leSocket = null;
        connectLE();
    });


}

function le_write(token, message){
    if (!leSocket.ready) return;
    leSocket.write(token + ' ' + message + '\n'); 
}

async function logContainers(id, since){
    // get all containers
    var containers = await getContainers();
    for (var i=0; i < containers.length; i++){
        var c = containers[i];

        if (id && since && c['Id'] === id){
            _logContainer(c, since);
        }
        _logContainer(c);
    }
    
};

function _logContainer(c, since){
    // stop if already exist in connection pool
    if (containerPool[c.Id]){
        return;
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

    listenDockerLog({id: c.Id, logset:logset, since: since});

}


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
    // TODO: may also need to close the "stream" ?
    logStream.on('data', function(chunk){
        var l = dockerLogToObj(chunk); 
        // add the Labels to the real log object
        for (var i=0; i < this.info.logset.length; i++){
            try{
                var logset = this.info.logset[i];
                // fire the log!
                le_write(logset.token, JSON.stringify(Object.assign(l, logset.labels)));
            }catch(err){
                log('LOG_ERROR: ' + err);
            }
        }
    });

    logStream.on('end', function(){
        log('LogSteam ended! ' + logStream.info.id);
    })
    logStream.on('error', function(){
        log('LogSteam error! ' + logStream.info.id);
    })

    logStream.on('close', function(){
        log('LogSteam closed! ' + logStream.info.id);
    })

    if (!info['since']){
        info['since'] = Math.floor(new Date().getTime()/1000) - 1; 
    }

    container.logs({
        follow: true,
        stdout: true,
        stderr: true,
        timestamps: true,
        // unixtime in SEC, very on99!
        since: info['since'], 
    }, function(err, stream){
        if(err) {
            log(err);
            return;
        }

        container.modem.demuxStream(stream, logStream, logStream);
        log('Container log stream connected! ' + logStream.info.id);

        stream.on('error', function(err){
            log('Container stream error! ' + logStream.info.id);
            log(err);
        });

        stream.on('end', function(){
            log('Container stream ended! "' + logStream.info.id );
            delete containerPool[logStream.info.id]; // remove socket object from the pool
            logStream.end('!stop!');
        });

        stream.on('close', function(){
            log('Container stream closed! "' + logStream.info.id );
            log('Container "' + logStream.info.id +'" stopped!');
            delete containerPool[logStream.info.id];
            logStream.end('!stop!');
        });

    });
}


/* Docker events sample
{
    "status": "start",
    "id": "451368a754f26702c12dbc44cfc7ac7096f775c57415522bb57005b0881de834",
    "from": "quay.io/onesky/dummy-log",
    "Type": "container",
    "Action": "start",
    "Actor": {
        "ID": "451368a754f26702c12dbc44cfc7ac7096f775c57415522bb57005b0881de834",
        "Attributes": {
            "image": "quay.io/onesky/dummy-log",
            "name": "optimistic_spence"
        }
    },
    "time": 1489729976,
    "timeNano": 1489729976229354000
}


{
    "status": "die",
    "id": "9c84c4fba102a75ad1e501b78fa80338e32fc39d356d7421f23e49d80cc0212b",
    "from": "quay.io/onesky/dummy-log",
    "Type": "container",
    "Action": "die",
    "Actor": {
        "ID": "9c84c4fba102a75ad1e501b78fa80338e32fc39d356d7421f23e49d80cc0212b",
        "Attributes": {
            "exitCode": "0",
            "image": "quay.io/onesky/dummy-log",
            "name": "nervous_northcutt"
        }
    },
    "time": 1489730101,
    "timeNano": 1489730101166362600
}

*/
function listenDockerEvent(){
    try{
        if (dockerEvtSocket.ready) {
            return;
        }
    }catch(err){}

    docker.getEvents({},function(err, res){
        if (err){
            console.log(err);
            return;
        }
        dockerEvtSocket = res;
        dockerEvtSocket.ready = true;
        res.on('data', function(data){

            var event = JSON.parse(data.toString());
            /* 
             * Only 2 events will be considered:
             * 1. container -> start (just log that container)
             * 2. container -> die (log only)
             */
            if (event['Type'] !== 'container') {
                return;
            }

            if (event['status'] === 'start') {
                log('[DOCKER_EVENT] ' + event['id']  + ' '+  event['status'] );
                logContainers(event['id'], event['time']);
                return;
            }

            if (event['status'] === 'die') {
                log('[DOCKER_EVENT] ' + event['id']  + ' '+  event['status'] );
                return;
            }
        })

        res.on('error', function(){
            log('[ERROR] Listen Docker Event error.');

        })
        res.on('end', function(){
            log('[ERROR] Listen Docker Event connection end.');
            dockerEvtSocket = null;
            listenDockerEvent();
        })
        res.on('close', function(){
            log('[ERROR] Listen Docker Event connection closed.');
            dockerEvtSocket = null;
            listenDockerEvent();
        })

        log('Listening Docker Events...');
    })

}



