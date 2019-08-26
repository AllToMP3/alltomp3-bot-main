const WebSocketServer = require('websocket').server;
const http = require('http');
const express = require('express');
const bodyParser = require('body-parser');
const randomstring = require("randomstring");
const rp = require('request-promise');
const alltomp3 = require('alltomp3');
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('/data/data.sqlite');

const { BOT, ID, API } = require('./config');
// const BOT = '@AllToMP3_bot';
// const ID = 123456;
// const API = 'https://api.telegram.org/bot' + KEY + '/';

db.run("CREATE TABLE clients(id INTEGER PRIMARY KEY AUTOINCREMENT, key VARCHAR(40) UNIQUE, password VARCHAR(20), confirm VARCHAR(20))", (err) => {});
db.run("CREATE TABLE chats(id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER UNIQUE, client INTEGER)", (err) => {});
db.run("CREATE TABLE admins(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, client INTEGER)", (err) => {});

let clients = {}; // connected clients
let queries = {}; // current queries
let demands = {}; // associate a message the bot sent to the telegram user that spoke to us

let app = express();

app.use(bodyParser.json());
app.post('/webhook', function(req, res) {
  console.log('Message received', req.body.message);
  let m = req.body.message;
  let cbq = req.body.callback_query;
  if (m) {
    let registerr = new RegExp('^/register((' + BOT + ')?) ([a-zA-Z0-9]+)-([a-zA-Z0-9]+)$');
    let dlr = new RegExp('^/dl((' + BOT + ')?) (.+)$');
    if (m.chat.type === 'private') {
      if (m.text) {
        let mregister = m.text.match(registerr);
        if (mregister) {
          db.get("SELECT id FROM clients WHERE key = ? AND confirm = ?", [mregister[3], mregister[4]], function(err, row) {
            if (!err && row && row.id > 0) {
              db.run("INSERT INTO admins(user_id, client) VALUES (?, ?)", [m.from.id, row.id], function() {
                telegramq('sendMessage', {
                  chat_id: m.chat.id,
                  text: 'You now manage the client ' + mregister[3]
                });
              });
              db.run("INSERT INTO chats(chat_id, client) VALUES (?, ?)", [m.chat.id, row.id], err => {});
            } else {
              telegramq('sendMessage', {
                chat_id: m.chat.id,
                text: 'Either the key of the confirm key is wrong'
              });
            }
          });
        } else if (m.text === '/removeall') {
          db.run("DELETE FROM admins WHERE user_id = ?", [m.from.id], err => {});
        }
      }
    } else if (m.chat.type === 'group' || m.chat.type === 'supergroup') {
      if (m.new_chat_members && m.new_chat_members.length > 0) {
        m.new_chat_members.forEach(cm => {
          if (cm.id === ID) { // The bot has been added to a chat
            db.all("SELECT clients.id, clients.key FROM admins LEFT JOIN clients ON clients.id = admins.client WHERE admins.user_id = ?", [m.from.id], function(err, rows) {
              if (!err && rows && rows.length > 0) {
                if (rows.length === 1) {
                  db.run("INSERT INTO chats(chat_id, client) VALUES (?, ?)", [m.chat.id, rows[0].id], function() {
                    telegramq('sendMessage', {
                      chat_id: m.chat.id,
                      text: '@' + m.from.username + ' This chat will use the client ' + rows[0].key + '\n\nUse /dl to download a song!'
                    });
                  });
                } else {
                  let cchoices = rows.map(r => r.key).join('\n').trim();
                  telegramq('sendMessage', {
                    chat_id: m.chat.id,
                    text: '@' + m.from.username + ' You manage multiple clients. Which one do you want to use? Tell me with /use the-key\n\n' + cchoices
                  });
                }
              } else {
                telegramq('sendMessage', {
                  chat_id: m.chat.id,
                  text: "@" + m.from.username + " You don't manage any client. Someone managing a client must re-invite me."
                });
                // here, maybe the bot should leave
              }
            });
          }
        });
      } else if (m.left_chat_member && m.left_chat_member.id === ID) {
        db.run("DELETE FROM chats WHERE chat_id = ?", [m.chat.id], err => {});
      } else if (m.text && m.text.match(dlr)) {
        db.get("SELECT clients.id FROM chats LEFT JOIN clients ON clients.id = chats.client WHERE chats.chat_id = ?", [m.chat.id], function(err, row) {
          if (!err && row && row.id) {
            if (!clients[row.id]) {
              telegramq('sendMessage', {
                chat_id: m.chat.id,
                text: 'Unfortunately, the client associated to this chat is currently down.'
              });
            } else {
              let q = m.text.match(dlr)[3];
              let type = alltomp3.typeOfQuery(q);
              if (type === 'text') {
                console.log('alltomp3.suggestedSongs', q);
                alltomp3.suggestedSongs(q, 5).then(suggestions => {
                  console.log('suggestions found');
                  let buttons = [];
                  suggestions.forEach(s => {
                    buttons.push([{
                      text: s.title + ' - ' + s.artistName,
                      callback_data: 'deezerId:' + s.deezerId
                    }]);
                  });
                  buttons.push([{
                    text: 'Other...',
                    callback_data: 'none'
                  }]);
                  telegramq('sendMessage', {
                    chat_id: m.chat.id,
                    text: 'Which song do you want to download?',
                    reply_markup: {
                      inline_keyboard: buttons
                    }
                  }).then(tm => { demands[tm.result.message_id] = m.from.id });
                });
              } else if (type === 'track-url' || type === 'single-url') {
                telegramq('sendMessage', {
                  chat_id: m.chat.id,
                  text: 'Download launched'
                }).then(tm => {
                  queries[qid] = {
                    chat_id: m.chat.id,
                    message_id: tm.result.message_id
                  };
                });
                let qid = randomstring.generate(20);
                if (type === 'track-url') {
                  senda(clients[row.id], {query: {id: qid, trackURL: q}});
                } else if (type === 'single-url') {
                  senda(clients[row.id], {query: {id: qid, singleURL: q}});
                }
              }
            }
          } else {
            telegramq('sendMessage', {
              chat_id: m.chat.id,
              text: 'This chat is link to no client. Someone managing a client must re-invite me.'
            });
          }
        });
      }
    }
  } else if (cbq) {
    db.get("SELECT clients.id FROM chats LEFT JOIN clients ON clients.id = chats.client WHERE chats.chat_id = ?", [cbq.message.chat.id], function(err, row) {
      if (err || !row || !row.id || !clients[row.id] || !demands[cbq.message.message_id] || cbq.from.id !== demands[cbq.message.message_id]) {
        return;
      }
      if (cbq.data === 'none') {
        telegramq('editMessageText', {
          chat_id: cbq.message.chat.id,
          message_id: cbq.message.message_id,
          text: 'Perform a new query with /dl'
        });
        return;
      }
      telegramq('editMessageText', {
        chat_id: cbq.message.chat.id,
        message_id: cbq.message.message_id,
        text: 'Download launched'
      });
      let deezerId = cbq.data.split(':')[1];
      let qid = randomstring.generate(20);
      queries[qid] = {
        chat_id: cbq.message.chat.id,
        message_id: cbq.message.message_id
      };
      senda(clients[row.id], {query: {id: qid, trackURL: 'http://www.deezer.com/track/' + deezerId}});
    });
  }
  res.send('');
});

var server = http.createServer(app);
server.listen(8080, function() {
    console.log((new Date()) + ' Server is listening on port 8080');
});

let wsServer = new WebSocketServer({
  httpServer: server,
  // You should not use autoAcceptConnections for production
  // applications, as it defeats all standard cross-origin protection
  // facilities built into the protocol and the browser.  You should
  // *always* verify the connection's origin and decide whether or not
  // to accept it.
  autoAcceptConnections: false,
  maxReceivedMessageSize: 20000000,
  maxReceivedFrameSize: 400000
});

function originIsAllowed(origin) {
  // put logic here to detect whether the specified origin is allowed.
  return true;
}

wsServer.on('request', function(request) {
  if (!originIsAllowed(request.origin)) {
    // Make sure we only accept requests from an allowed origin
    request.reject();
    console.log((new Date()) + ' Connection from origin ' + request.origin + ' rejected.');
    return;
  }

  var connection = request.accept('echo-protocol', request.origin);
  console.log((new Date()) + ' Connection accepted.');

  // Status of the connection
  // 0: Created
  // 1: Authenticated
  let status = 0;
  let key;

  connection.on('message', function(message) {
    if (message.type === 'utf8') {
      console.log('Received Message: ' + message.utf8Data);
      try {
        var message = JSON.parse(message.utf8Data);
      } catch(e) {
        return;
      }
      // The first message should be the credentials
      if (status === 0) {
        if (message.hello && !message.key && !message.password) {
          // It says hello without credentials,
          // we will register it
          key = randomstring.generate(40);
          let password = randomstring.generate(20);
          let confirm = randomstring.generate(20);
          db.run("INSERT INTO clients(key, password, confirm) VALUES (?, ?, ?)", [key, password, confirm], function() {
            status = 1;
            clients[this.lastID] = connection;
            senda(connection, {key: key, password: password, confirm: confirm});
          });
        } else if (!message.key || !message.password) {
          return senda(connection, {error: "key or password missing"});
        } else if (message.key && message.password) {
          db.get("SELECT id FROM clients WHERE key = ? AND password = ?", [message.key, message.password], function(err, row) {
            if (err || !row || !row.id) {
              return senda(connection, {error: "wrong key or password"});
            }
            status = 1;
            key = message.key;
            clients[row.id] = connection;
          });
        }
      } else {
        if (message.id && message.progress && queries[message.id]) {
          telegramq('editMessageText', {
            chat_id: queries[message.id].chat_id,
            message_id: queries[message.id].message_id,
            text: 'Downloading (' + Math.floor(message.progress) + '%)'
          });
        } else if (message.id && message.error) {
          telegramq('editMessageText', {
            chat_id: queries[message.id].chat_id,
            message_id: queries[message.id].message_id,
            text: 'An error occured, sorry.'
          });
        }
      }
    } else if (message.type === 'binary') {
      console.log('Received Binary Message of ' + message.binaryData.length + ' bytes');
      let id = message.binaryData.toString('utf8', 0, 20);
      console.log('Audio received for', id);
      const audio = message.binaryData.slice(20);
      let q = queries[id];
      if (!q) {
        return;
      }

      telegramq('editMessageText', {
        chat_id: q.chat_id,
        message_id: q.message_id,
        text: 'Downloaded!'
      });

      var formData = {
        chat_id: q.chat_id,
        audio: {
          value:  audio,
          options: {
            filename: 'music.mp3',
            contentType: 'audio/mp3'
          }
        }
      };
      rp.post({url:API + 'sendAudio', formData: formData}, (err, resp, body) => {
        console.log('FINI', err);
      });
    }
  });
  connection.on('close', function(reasonCode, description) {
    delete clients[key];
    console.log((new Date()) + ' Peer ' + connection.remoteAddress + ' disconnected.');
  });
});

let senda = (connection, message) => {
  console.log('Send', JSON.stringify(message));
  connection.sendUTF(JSON.stringify(message));
};
let telegramq = (endpoint, data) => {
  var options = {
    method: 'POST',
    uri: API + endpoint,
    body: data,
    json: true
  };

  return rp(options);
};
