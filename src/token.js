// Description:
//   A script that expands mentions of lists. Lists themselves can be used as
//   members if prepended with '&', and mentions will be expanded recursively.
//
// Dependencies:
//   None
//
// Configuration:
//   HUBOT_LIST_DECORATOR - a character indicating how to decorate usernames.
//     Valid settings are '<', '(', '[', and '{'. This variable can also be left
//     unset. This setting defaults to ''.
//   HUBOT_LIST_PREPEND_USERNAME - set to 'false' to disable prepending the
//     original username to the prepended message. This variable can also be
//     left unset. This setting defaults to 'true'.
//   HUBOT_LIST_RECURSE - set to 'false' to disable recursive list expansion.
//     The setting defaults to 'true'.
//
// Commands:
//   hubot token show buckets - list all token buckets
//   hubot token create bucket <bucket> - create a new token bucket
//   hubot token destroy bucket <bucket> - destroy a token bucket
//   hubot token issue <number> tokens from <bucket> to <user> - issue tokens
//
// Author:
//   Josh King <jking@chambana.net>, based on hubot-group by anishathalye
//

const Papa = require("papaparse");
const crypto = require("crypto");
const fs = require("fs");
const IDENTIFIER = "[-._a-zA-Z0-9]+";
const TOKEN_STATE = { COMPLETED: 0, DUPLICATE: 1, INVALID: 2 };

function isString(s) {
  return typeof s === "string" || s instanceof String;
}

function random(howMany, chars) {
  chars =
    chars || "abcdefghijklmnopqrstuwxyzABCDEFGHIJKLMNOPQRSTUWXYZ0123456789";
  const rnd = crypto.randomBytes(howMany);
  const value = new Array(howMany);
  const len = Math.min(256, chars.length);
  const d = 256 / len;

  for (let i = 0; i < howMany; i++) {
    value[i] = chars[Math.floor(rnd[i] / d)];
  }

  return value.join("");
}

function sorted(arr) {
  const copy = Array.from(arr);
  return copy.sort();
}

function isString(s) {
  return typeof s === "string" || s instanceof String;
}

class BucketList {
  constructor(robot) {
    this.load = this.load.bind(this);
    this.buckets = this.buckets.bind(this);
    this.exists = this.exists.bind(this);
    this.get = this.get.bind(this);
    this.set = this.set.bind(this);
    this.rename = this.rename.bind(this);
    this.robot = robot;
    this.cache = {};
    this.robot.brain.on("loaded", this.load);
    if (this.robot.brain.data.users.length) {
      this.load();
    }
  }

  load() {
    if (this.robot.brain.data.tokens) {
      this.cache = this.robot.brain.data.tokens;
      Object.entries(this.robot.brain.data.tokens).forEach(([name, bucket]) => {
        if (bucket) {
          const deserialized = new Bucket();
          deserialized.load(bucket._data);
          this.cache[name] = deserialized;
        }
      });
    } else {
      this.robot.brain.data.tokens = this.cache;
    }
  }

  buckets() {
    return sorted(Object.keys(this.cache));
  }

  exists(bucket) {
    return this.cache[bucket] != null;
  }

  get(bucket) {
    return this.cache[bucket];
  }

  set(id, bucket) {
    if (bucket instanceof Bucket && !this.exists(id)) {
      this.cache[id] = bucket;
      return true;
    }
    return false;
  }

  delete(id) {
    if (this.exists(id)) {
      delete this.cache[id];
      return true;
    }
    return false;
  }

  rename(from, to) {
    if (!this.exists(from) || this.exists(to)) {
      return false;
    } else {
      this.cache[to] = this.cache[from];
      delete this.cache[from];
      return true;
    }
  }

  [Symbol.iterator]() {
    return Object.entries(this.cache);
  }
}

class Bucket {
  constructor() {
    this.issue_to = this.issue_to.bind(this);
    this.clean_expired = this.clean_expired.bind(this);
    this.push = this.push.bind(this);
    this.info = this.info.bind(this);
    this._data = {};
  }

  load(data) {
    this._data = data;
    Object.values(this._data).forEach(token => {
      if (typeof token != Token) {
        const t = new Token(token.code, token.value, token.expiry, token.label);
        t._added = token._added;
        t._issued_date = token._issued_date;
        t._issued_to = token._issued_to;
        this._data[token.code] = t;
      }
    });
  }

  issue_to(user, number = 1) {
    const issued = [];
    let count = 0;
    Object.values(this._data).forEach(token => {
      if (token instanceof Token) {
        if (!token.is_issued() && !token.is_expired() && count < number) {
          issued.push(token.issue_to(user));
          count++;
        }
      }
    });
    return issued;
  }

  clean_expired() {
    this._data = Object.values(this._data)
      .filter(token => token instanceof Token && !token.is_expired())
      .reduce((obj, code) => {
        obj[code] = this._data[code];
        return obj;
      }, {});
  }

  clean_issued() {
    this._data = Object.values(this._data)
      .filter(token => token instanceof Token && !token.is_issued())
      .reduce((obj, code) => {
        obj[code] = this._data[code];
        return obj;
      }, {});
  }

  push(token, force = false) {
    if (!token.code) {
      return TOKEN_STATE.INVALID;
    }
    if (token.code in this._data && !force) {
      return TOKEN_STATE.DUPLICATE;
    }
    this._data[token.code] = token;
    return TOKEN_STATE.COMPLETED;
  }

  info() {
    let total = 0;
    let issued = 0;
    let expired = 0;
    Object.values(this._data).forEach(token => {
      if (token instanceof Token) {
        total++;
        if (token.is_expired()) expired++;
        if (token.is_issued()) issued++;
      }
    });
    return { total: total, issued: issued, expired: expired };
  }
}

class Token {
  constructor(code, value, expiry, label) {
    this.issue_to = this.issue_to.bind(this);
    this.is_issued = this.is_issued.bind(this);
    this.is_expired = this.is_expired.bind(this);
    this.code = code;
    this.value = value;
    this.expiry = expiry;
    this.label = label;
    this._added = new Date();
    this._issued_to = null;
    this._issued_date = null;
  }

  issue_to(to) {
    this._issued_to = to;
    this._issued_date = new Date();
    return {
      code: this.code,
      value: this.value,
      expiry: this.expiry,
      label: this.label
    };
  }

  is_issued() {
    return this._issued_to != null;
  }

  is_expired() {
    if (this._expiry != null) {
      const now = new Date();
      return this._expiry.getTime() < now.getTime();
    } else {
      return false;
    }
  }
}

module.exports = function(robot) {
  const tokens = new BucketList(robot);

  robot.listenerMiddleware((context, next, done) => {
    if (
      context.listener.options.id &&
      context.listener.options.id.match(
        new RegExp(`^token\\.[a-zA-Z0-9]+$`, "i")
      )
    ) {
      if (robot.auth.isAdmin(context.response.message.user.id)) {
        // User is allowed access to this command
        return next();
      } else {
        // Restricted command, but user isn't in whitelist
        context.response.reply(
          `I'm sorry, @${context.response.message.user.name}, but you don't have access to do that.`
        );
        return done();
      }
    } else {
      // This is not a restricted command; allow everyone
      return next();
    }
  });

  robot.respond(
    "/token create bucket (.*)/i",
    { id: "token.bucket_add" },
    res => {
      const name = res.match[1];
      const type = res.match[2];
      let success = false;
      if (type === "mullvad" || type === "Mullvad") {
        const bucket = new Bucket();
        success = tokens.set(name, bucket);
      } else {
        const bucket = new Bucket();
        success = tokens.set(name, bucket);
      }

      if (success) {
        res.send(`Added new token bucket ${name}.`);
      } else {
        res.send(`Token bucket ${name} already exists.`);
      }
    }
  );

  robot.respond(
    "/token destroy bucket (.*)/i",
    { id: "token.bucket_remove" },
    res => {
      const name = res.match[1];
      let success = false;
      if (tokens.exists(name)) {
        success = tokens.delete(name);
      }
      if (success) {
        res.send(`Removed token bucket ${name}.`);
      } else {
        res.send(`Token bucket ${name} doesn't exist.`);
      }
    }
  );

  robot.respond(
    "/token import to (.*)/i",
    { id: "token.token_import" },
    res => {
      const bucket = res.match[1];
      let completed = 0;
      let duplicate = 0;
      let invalid = 0;
      let expiry = null;
      let b;
      if (tokens.exists(bucket)) {
        b = tokens.get(bucket);
      } else {
        res.send(`Token bucket ${bucket} doesn't exist.`);
        return;
      }
      function insertToken(results, parser) {
        if (!results.data.code || !isString(results.data.code)) {
          robot.logger.error("Invalid result: ", results);
          invalid++;
          return;
        }
        if (results.data.expiry) {
          expiry = Date.parse(results.data.expiry);
          expiry = !isNaN(date) ? date : null;
        }

        const token = new Token(
          results.data.code,
          results.data.value || results.data.days,
          expiry,
          results.data.label
        );
        const state = b.push(token);
        switch (state) {
          case TOKEN_STATE.COMPLETED:
            completed++;
            break;
          case TOKEN_STATE.DUPLICATE:
            duplicate++;
            break;
          case TOKEN_STATE.INVALID:
            invalid++;
        }
        return;
      }
      function complete(results, file) {
        res.send(
          `Imported tokens to bucket ${bucket}: ${completed} completed, ${duplicate} duplicate, ${invalid} invalid.`
        );
      }

      res.envelope.message.attachments.map(path => {
        const file = fs.createReadStream(path);
        robot.logger.debug("Parsing path: ", path);
        Papa.parse(file, {
          step: insertToken,
          complete: complete,
          header: true,
          dynamicTyping: true
        });
      });
      robot.logger.debug("end of function");
    }
  );

  robot.respond("/token show buckets/i", { id: "token.list_buckets" }, res => {
    const response = [];
    response.push("<Bucket>: (Total/Issued/Expired)");
    Object.entries(tokens.cache).forEach(([name, bucket]) => {
      let info = bucket.info();
      response.push(`${name}: (${info.total}/${info.issued}/${info.expired})`);
    });
    if (response.length > 1) {
      res.send(response.join("\n"));
    } else {
      res.send("No token buckets available.");
    }
  });

  robot.respond("/token show users/i", { id: "token.list_users" }, res => {
    const response = robot.auth.usersWithRole("recipients");
    response.unshift("Users:");
    if (response.length > 1) {
      res.send(response.join("\n"));
    } else {
      res.send(
        "No users available (given that you're a user, this may be an error!)."
      );
    }
  });

  robot.respond(
    "/token issue (.*) tokens from (.*) to (.*)/i",
    { id: "token.list_issue" },
    res => {
      const number = res.match[1] || 1;
      const bucket = res.match[2];
      const user = res.match[3];
      if (tokens.exists(bucket)) {
        if (robot.auth.hasRole(user, "recipients")) {
          const issued = tokens.get(bucket).issue_to(user, number);
          const userObject = robot.brain.userForId(user);
          userObject.issued = userObject.issued
            ? (userObject.issued += issued)
            : issued;
          if (issued.length > 0) {
            const response = [];
            response.push("You have been issued the following tokens:");
            issued.forEach(t => {
              const tokenString = [];
              if (t.code != null) {
                tokenString.push(`Code: ${t.code}`);
              }
              if (t.label != null) {
                tokenString.push(` for site ${t.label}`);
              }
              if (t.label != null) {
                tokenString.push(` value ${t.value}`);
              }
              if (t.expiry != null) {
                tokenString.push(` expiring ${t.date.toDateString()}`);
              }
              tokenString.join(` `);
              response.push(tokenString);
            });
            robot.messageRoom(user, response.join("\n"));
            res.send(`Sent ${issued.length} tokens to ${user}.`);
          } else {
            res.send(`No tokens available in bucket ${bucket}.`);
          }
        } else {
          res.send(`User ${res.match[3]} is not a valid recipient.`);
        }
      } else {
        res.send(`Token bucket ${bucket} doesn't exist.`);
      }
    }
  );
};
