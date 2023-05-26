const FTP = require("basic-ftp");
const { Curl } = require("node-libcurl");

const CLIENT_TIMEOUT = 30000; // 30 seconds
const TREE_CACHE_MS = 600000; // 10 minutes
const MAX_FILE_DOWNLOAD_SPEED = 20971520 // 20MB/s

let treeCache = {};
let downloadPermIPs = {};

async function getFileTree(hostStr) {
    let host = hostStr.includes("@") ? hostStr.split("@")[1] : hostStr;
    let user = undefined;
    let password = undefined;
    
    if(hostStr.includes("@")) {
        user = hostStr.split("@")[0].split(":")[0];
        password = hostStr.split("@")[0].split(":")[1];

        if(user && user.length == 0)
            user = undefined;
        if(password && password.length == 0)
            password = undefined;
    }

    let startTime = Date.now();
    console.log(`[FTP | ${maskHost(host)}] Fetching file tree`);

    let fileTree = {
        path: '',
        dirs: [],
        files: [],
    };
    let cached = false;
    let cacheExpired = false;

    if(treeCache[hostStr] && Date.now() - treeCache[hostStr].lastUpdated < TREE_CACHE_MS) {
        fileTree = treeCache[hostStr].tree;
        cached = true;
    } else {
        if(treeCache[hostStr]) {
            cacheExpired = true;
        }
        try {
            const client = new FTP.Client(CLIENT_TIMEOUT);
            await client.access({
                host,
                user,
                password,
            });

            await readPath(client, fileTree);
            treeCache[hostStr] = {
                tree: fileTree,
                lastUpdated: Date.now(),
            }
        } catch(e) {
            console.log(`[FTP | ${maskHost(host)}] Could not fetch file tree within ${CLIENT_TIMEOUT}ms: Supplying default data`);
            return fileTree;
        }
    }
    console.log(`[FTP | ${maskHost(host)}] Fetched file tree (took ${Date.now() - startTime}ms | ${cached ? "CACHE HIT" : "CACHE MISS | " + (cacheExpired ? "EXPIRED" : "UNPOPULATED")})`);
    return fileTree;
}

async function readPath(client, parentDir) {
    try {
        let list = await client.list(parentDir.path);
        for(const item of list) {
            let path = parentDir.path + '/' + item.name;
            if(item.type == FTP.FileType.Directory) {
                let dir = {
                    type: "dir",
                    path,
                    name: item.name,
                    size: item.size,
                    dirs: [],
                    files: [],
                };
                parentDir.dirs.push(dir)
                await readPath(client, dir);
            } else {
                parentDir.files.push({
                    type: "file",
                    path,
                    name: item.name,
                    size: item.size,
                    date: item.modifiedAt || parseShortDate(item.rawModifiedAt),
                })
            }
        }
        parentDir.lastUpdated = new Date().toISOString();
    } catch(e) {
        console.error(e);
    }
}

const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());

async function updateProxyIPs() {
    let proxyIPList = ["loopback"];

    let ipv4 = await fetch("https://www.cloudflare.com/ips-v4");
    proxyIPList = proxyIPList.concat((await ipv4.text()).split("\n"));

    let ipv6 = await fetch("https://www.cloudflare.com/ips-v6");
    proxyIPList = proxyIPList.concat((await ipv6.text()).split("\n"));

    app.set('trust proxy', proxyIPList);
    console.log(`[WEB] Updated trusted proxy list (${proxyIPList.length} entries)`);
}

updateProxyIPs();
setInterval(updateProxyIPs, 6 * 60 * 60000); // update every 6 hours

app.set('trust proxy', (ip) => {
    return proxyIPList.indexOf(ip) != -1;
}) 

const port = 80;

const staticData = {
    note: "No files are hosted on this server, this is simply a router",
};

app.get('/', async (req, res) => {
    let search = new URLSearchParams(req.query);
    if(!search.has("host")) {
        return res.sendStatus(400);
    }

    setCanDownload(req.ip, true);

    let tree = await getFileTree(search.get("host"));
    res.json(Object.assign({}, tree, staticData));
});

app.get('*', async (req, res) => {
    let search = new URLSearchParams(req.query);
    if(!search.has("host")) {
        return res.sendStatus(400);
    }

    let splitPath = req.path.replace(/\/$/g, '').split("/");
    splitPath.shift();
    let curr = await getFileTree(search.get("host"));
    for(let route of splitPath) {
        if(!curr)
            break;

        route = decodeURI(route);
        let item = curr.dirs.find(f => f.path == curr.path + '/' + route);
        if(!item)
            item = curr.files.find(f => f.path == curr.path + '/' + route);
        curr = item;
    }
    if(curr) {
        if(search.has("download") && curr.type == "file") {
            if(!checkDownload(req.ip)) {
                res.status(403);
                res.end();
                return;
            }

            setCanDownload(req.ip, true);

            const curl = new Curl();
            const close = curl.close.bind(curl);

            res.setHeader('Content-Type', 'application/octet-stream');
            if(curr.size) res.setHeader('Content-Length', curr.size);
            //res.setHeader('Transfer-Encoding', 'chunked');

            curl.setOpt(Curl.option.URL, `ftp://${search.get("host")}/${curr.path}`);
            if(req.headers['range'] != undefined) curl.setOpt(Curl.option.RANGE, req.headers['range']);

            curl.setOpt(Curl.option.MAX_RECV_SPEED_LARGE, MAX_FILE_DOWNLOAD_SPEED);

            curl.setOpt(Curl.option.WRITEFUNCTION, ( buffer, size, nmemb ) => {
                res.write(buffer);
                return size * nmemb;
            });

            curl.on('end', (status, data, headers, curlInstance) => {
                res.status(200);
                res.end();
                close();
            });
            curl.on('error', (error, errorCode, curlInstance) => {
                console.error(error);
                res.status(500);
                res.end();
                close();
            });
            req.on('close', () => {
                if(curl.isOpen)
                    close();
            });

            curl.perform();
        } else {
            setCanDownload(req.ip, true);
    
            res.json(Object.assign({}, curr, staticData));
        }
    } else
        res.sendStatus(404);
});

app.listen(port, '0.0.0.0', () => {
    console.log(`Proxy listening on port ${port}`)
})

process.on("uncaughtException", err => {
    console.error(err);
})

function maskHost(host) {
    if(host.length <= 8) {
        return host.substr(0, host.length-Math.ceil(host.length/4)) + '*'.repeat(Math.ceil(host.length/4));
    } else {
        return host.substr(0, 8) + '*'.repeat(host.length - 8);
    }
}

function parseShortDate(short) {
    let date = new Date(short);
    if(short.match(/^[A-Za-z]+ \d+ \d+:\d+$/)) {
        date.setFullYear(new Date().getFullYear()); // Set year to current because it isn't in the date string
    } else if(short.match(/^\d+:\d+$/)) {
        date.setFullYear(new Date().getFullYear()); // Set year to current because it isn't in the date string
        date.setMonth(new Date().getMonth()); // Set month to current because it isn't in the date string
        date.setDay(new Date().getDay()); // Set month to current because it isn't in the date string
    }
    return date.getTime();
}

function setCanDownload(ip, allowed) {
    if(allowed) {
        downloadPermIPs[ip] = Date.now();
    } else {
        downloadPermIPs[ip] = undefined;
        delete downloadPermIPs[ip];
    }
}

const DOWNLOAD_EXPIRY = 30 * 60000; // 30 minutes
function checkDownload(ip) {
    if(downloadPermIPs[ip] != undefined) {
        if(Date.now() - downloadPermIPs[ip] < DOWNLOAD_EXPIRY)
            return true;
        else
            setCanDownload(ip, false);
    }
    return false;
}