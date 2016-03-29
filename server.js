#!/usr/bin/env node
"use strict";

// package deps
let Promise = require("songbird");
let argv = require("yargs").argv;
let fs = require("fs");
let path = require("path");
let mkdirp = require("mkdirp");
let rimraf = require("rimraf");
let express = require("express");
let morgan = require("morgan");
let bodyParser = require("body-parser");
let cookieParser = require("cookie-parser");
let methodOverride = require("method-override");
let mime = require("mime-types");
let archiver = require("archiver");
let chokidar = require("chokidar");
let _ = require("lodash");
let events = require('events');
let config = require('config');
let eventEmitter = new events.EventEmitter();

const HOST = process.env.HOST || "127.0.0.1";
const NODE_ENV_DEV = "development";
const HTTP_PORT = process.env.PORT || "3000";
const TCP_PORT = config.get("TCP_PORT") || "6875";
const APP_DIR = argv.dir ? argv.dir : path.resolve(process.cwd());

// Logger
let wl = require("./winston_logger");

// Create an `nssocket` TCP server
let nssocket = require('nssocket');
let server = nssocket.createServer((socket) => {
    eventEmitter.on('put', (data) => {
        socket.send(['box-clone', 'clients', 'put'], data);
    });

    eventEmitter.on('post', (data) => {
        socket.send([['box-clone', 'clients', 'post']], data);
    });

    eventEmitter.on('delete', (data) => {
        socket.send(['box-clone', 'clients', 'delete'], data);
    });
});

server.listen(TCP_PORT, () => {
    wl.info(`TCP server is running on :${TCP_PORT}`);
});

// middlewares
let app = express();
app.use(bodyParser.json()); // for parsing application/json
app.use(bodyParser.urlencoded({extended: true})); // for parsing application/x-www-form-urlencoded w req.body
app.use(methodOverride()); // method override
app.use(cookieParser());
app.locals.host = HOST; // init global variables

// Simple app that will log all request in the Apache combined format to STDOUT
app.use(morgan("combined"));

app.get("*", setFileStatInReq, setHeader, (req, res) => {
    if (res.err) {
        return res.status(500).send("Something broke!");
    }
    if (req.stat.isDirectory() && req.header("Accept") === "application/x-gtar") {
        let archive = archiver("zip");
        archive.on("error", (err) => {
            wl.error(err);
        });
        archive.on("close", () => {
            return res.status(200).send("ok").end();
        });
        archive.pipe(res);
        archive.bulk([{expand: true, cwd: req.filePath, src: ["**"]}]);
        archive.finalize((err) => {
            if (err) {
                wl.error(err);
            }
        });
    }
    if (res.body) {
        wl.debug(res.body);
        return res.json(res.body);
    }
});

app.head("*", setFileStatInReq, setHeader, (req, res) => {
    res.end();
});


app.put("*", setFileStatInReq, setFileDirInfoInReq, (req, res) => {
    if (req.stat) {
        wl.error("PUT 405: File/folder exists");
        return res.status(405).send("the file or directory exists");
    }

    if (req.isPath) {
        mkdirp.promise(req.dirPath)
            .then(() => {
                wl.info(`PUT: Folder created ${req.dirPath}`);
                res.end();
            })
            .catch((err) => {
                wl.error(err);
            });
    } else {
        fs.writeFile.promise(req.filePath, req.bodyText)
            .then(() => {
                wl.info(`PUT: File created ${req.filePath} content is ${req.bodyText}`);
                res.end();
            })
            .catch((err) => {
                wl.error(err);
            });
    }

    // Notify TCP client: PUT
    eventEmitter.emit("put", {
        "type": "put",
        "filePath": req.filePath.replace(path.resolve(APP_DIR, "box-clone"), ""),
        "isPath": req.isPath,
        "bodyText": req.bodyText,
        "timestamp": Date.now()
    });
});


app.delete("*", setFileStatInReq, (req, res) => {
    if (!req.stat) { //validate path not exist
        wl.error("DELETE 400: Invalid path");
        return res.status(400).send("DELETE 400: Invalid path");
    }

    if (req.stat.isDirectory()) {
        rimraf.promise(req.filePath)
            .then(() => {
                wl.info(`DELETE: Folder deleted ${req.filePath}`);
                res.end();
            });
    } else {
        fs.unlink.promise(req.filePath)
            .then(() => {
                wl.info(`DELETE: File deleted ${req.filePath}`);
                res.end();
            });
    }

    eventEmitter.emit("delete", {
        "type": "delete",
        "filePath": req.filePath.replace(path.resolve(APP_DIR, "box-clone"), ""),
        "isPathDir": req.stat.isDirectory(),
        "timestamp": Date.now()
    });
});

app.post("*", setFileStatInReq, setFileDirInfoInReq, (req, res) => {
    if (!req.stat || req.isPathDir) {
        wl.error("POST 405: file does not exist or it is a folder");
        return res.status(405).send("POST 405: file does not exist or it is a folder");
    }

    fs.truncate.promise(req.filePath, 0)
        .then(() => {
            fs.writeFile.promise(req.filePath, req.bodyText)
                .then(() => {
                    wl.info(`POST: File updated ${req.filePath} content is ${req.bodyText}`);
                    res.end();
                });
        });

    eventEmitter.emit("post", {
        "type": "post",
        "filePath": req.filePath.replace(path.resolve(APP_DIR, "box-clone"), ""),
        "isPathDir": req.isPathDir,
        "bodyText": req.bodyText,
        "timestamp": Date.now()
    });
});

function setFileStatInReq(req, res, next) {
    req.filePath = path.resolve(path.join(APP_DIR, req.url));
    fs.stat.promise(req.filePath)
        .then((stat) => {
            req.stat = stat;
        })
        .catch((err) => {
            wl.error(err);
            req.stat = null;
        })
        .then(next);
}

function setFileDirInfoInReq(req, res, next) {
    if (req.body) {
        // when execute curl -v "http://localhost:3000/foo/foo.js" -d 'bar' -X PUT, 'bar' appears in the key, use Object.keys to extract
        req.bodyText = Object.keys(req.body)[0] || "";
    }
    if (req.stat && req.stat.isDirectory()) {
        req.dirPath = req.filePath;
    }
    let checkPathDir = (filePath) => {
        if (_.last(filePath) === path.sep || !path.extname(filePath)) {
            return true;
        }
        return false;
    };
    req.isPath = checkPathDir(req.filePath);
    req.dirPath = req.isPath ? req.filePath : path.dirname(req.filePath);
    next();
}

function setHeader(req, res, next) {
    if (!req.stat) {
        return next();
    }

    if (req.stat.isDirectory()) {
        if (req.header("Accept") === "application/x-gtar") {
            wl.info("GET: directory zip");
            res.setHeader("Content-Type", "application/zip");
            res.attachment("archive.zip");
            next();
        } else {
            wl.info("GET: directory list");
            fs.readdir.promise(req.filePath)
                .then((fileNames) => {
                    wl.info("GET: readdir - " + fileNames);
                    res.body = JSON.stringify(fileNames);
                    res.setHeader('Content-Length', res.body.length);
                    res.setHeader('Content-Type', 'application/json');
                })
                .catch((err) => {
                    wl.error(err);
                })
                .then(next);
        }
    } else {
        wl.info("GET: file");
        res.setHeader("Content-Length", req.stat.size);
        let contentType = mime.contentType((path.extname(req.filePath)));
        res.setHeader("Content-Type", contentType);
        //res.download(req.filePath); //download file w express helper
        let fileStream = fs.createReadStream(req.filePath);
        fileStream.on("error", (err) => {
            res.error = err;
            wl.error(err);
            next();
        });
        fileStream.pipe(res);
        next();
    }
}

// File watcher
let watcher = chokidar.watch(path.resolve(process.cwd(), "box-clone"), {ignored: /[\/\\]\./});
watcher
    .on("add", (filePath) => { //add file
        wl.debug("Add file", filePath);
        fs.readFile.promise(filePath, "utf8").then((text) => {
            eventEmitter.emit("put", {
                "type": "put",
                "filePath": filePath.replace(path.resolve(APP_DIR, "box-clone"), ""),
                "isPathDir": false,
                "bodyText": text,
                "timestamp": Date.now()
            });
        });
    })
    .on("change", (filePath) => { //update file
        wl.debug("Update file", filePath);

        fs.readFile.promise(filePath, "utf8").then((text) => {
            eventEmitter.emit("post", {
                "type": "post",
                "filePath": filePath.replace(path.resolve(APP_DIR, "box-clone"), ""),
                "isPathDir": false,
                "bodyText": text,
                "timestamp": Date.now()
            });
        });
    })
    .on("addDir", (filePath) => { //add dir
        wl.debug("Add dir", filePath);

        eventEmitter.emit("put", {
            "type": "put",
            "filePath": filePath.replace(path.resolve(APP_DIR, "box-clone"), ""),
            "isPathDir": true,
            "timestamp": Date.now()
        });
    })
    .on("unlink", (filePath) => { //delete file
        wl.debug("delete file", filePath);

        eventEmitter.emit("delete", {
            "type": "delete",
            "filePath": filePath.replace(path.resolve(APP_DIR, "box-clone"), ""),
            "isPathDir": false,
            "timestamp": Date.now()
        });
    })
    .on("unlinkDir", (filePath) => { //delete folder
        wl.debug("delete folder", filePath);

        eventEmitter.emit("delete", {
            "type": "delete",
            "filePath": filePath.replace(path.resolve(APP_DIR, "box-clone"), ""),
            "isPathDir": true,
            "timestamp": Date.now()
        });
    });

// Start Express server
app.listen(HTTP_PORT);
wl.info(`Express server is running at http://${HOST}:${HTTP_PORT}`);
wl.info(`Folder DIR is ${APP_DIR}`);
