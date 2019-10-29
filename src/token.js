// Description:
//   A script that manages and distributes arbitrary buckets of tokens. Tokens
//   are imported from CSV files, and there is special handling for account
//   and voucher tokens for the Mullvad VPN provider. Requires hubot-list.
//
// Dependencies:
//   None
//
// Commands:
//   hubot token show buckets - list all token buckets
//   hubot token show users - list all valid recipients
//   hubot token create [bucket] <bucket> [of mullvadaccounts|mullvadcodes]- create a new token bucket
//   hubot token destroy [bucket] <bucket> - destroy a token bucket
//   hubot import to <bucket> - import CSV file to bucket, must use an adapter with file attachments (currently only Signal supported)
//   hubot token issue <number> token[s] from <bucket> to <user> - issue tokens
//   hubot token apply [token] [with value N] from <bucket> to <user> - apply voucher code to user's account (Mullvad only)
//
// Author:
//   Josh King <josh@throneless.tech>
//

const Conversation = require("hubot-conversation");
const Papa = require("papaparse");
const crypto = require("crypto");
const fs = require("fs");
const IDENTIFIER = "[-._a-zA-Z0-9]+";
const TOKEN_STATE = { COMPLETED: 0, DUPLICATE: 1, INVALID: 2 };
const MULLVAD_URL = "https://api.mullvad.net/public/vouchers/submit/v1/";

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
          let deserialized;
          switch (bucket._type) {
            case "MullvadCodes":
              deserialized = new MullvadCodes();
              break;
            case "MullvadAccounts":
              deserialized = new MullvadAccounts();
              break;
            default:
              deserialized = new Bucket();
          }
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
  constructor(_type = "generic") {
    this.issue_to = this.issue_to.bind(this);
    this.clean_expired = this.clean_expired.bind(this);
    this.push = this.push.bind(this);
    this.info = this.info.bind(this);
    this._type = _type;
    this._data = {};
  }

  load(data) {
    this._data = data;
    Object.values(this._data).forEach(token => {
      if (typeof token != Token) {
        const expiry = token.expiry ? Date.parse(String(token.expiry)) : null;
        const added = token._added ? Date.parse(String(token._added)) : null;
        const issued_date = token._issued_date
          ? Date.parse(String(token._issued_date))
          : null;
        const t = new Token(token.code, token.value, expiry, token.label);
        t._added = added;
        t._issued_date = issued_date;
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
          issued.push(token.issue_to(user.id));
          user._issued = user._issued ? ++user._issued : 1;
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

class MullvadCodes extends Bucket {
  constructor() {
    super("MullvadCodes");
  }

  get_code(value) {
    const sorted = Object.values(this._data)
      .sort((t1, t2) => (t1.expiry < t2.expiry ? -1 : 1))
      .filter(t => !t.is_issued() && !t.is_expired());
    if (value) {
      return sorted.find(t => t === value);
    } else {
      return sorted[0];
    }
  }

  apply_to(robot, user, accountNumber, token) {
    if (!(user._accounts && user._accounts instanceof Array)) {
      user._accounts = new Array();
    }
    if (
      !token.is_issued() &&
      !token.is_expired() &&
      user._accounts[accountNumber]
    ) {
      const data = `account=${user._accounts[accountNumber]}&code=${token.code}`;
      robot
        .http(MULLVAD_URL)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .post(data)((err, resp, body) => {
        if (err) {
          robot.logger.debug(`Error calling Mullvad API: ${err.code}`);
          return false;
        }
        switch (resp.statusCode) {
          case 200:
            robot.logger.debug(
              `Successfully applied Mullvad voucher ${data.code} to ${data.account}.`
            );
            token.issue_to(user.id);
            return true;
          default:
            robot.logger.debug(
              `Mullvad API error code ${resp.statusCode}: ${body}.`
            );
            return false;
        }
      });
    } else {
      return false;
    }
  }
}

class MullvadAccounts extends Bucket {
  constructor() {
    super("MullvadAccounts");
  }

  issue_to(user, number = 1) {
    const issued = [];
    let count = 0;
    if (!(user._accounts && user._accounts instanceof Array)) {
      user._accounts = new Array();
    }
    Object.values(this._data).forEach(token => {
      if (token instanceof Token) {
        if (!token.is_issued() && !token.is_expired() && count < number) {
          issued.push(token.issue_to(user.id));
          user._accounts.push(token.code);
          user._issued = user._issued ? user._issued++ : 1;
          count++;
        }
      }
    });
    return issued;
  }
}

class Token {
  constructor(code, value = 0, expiry, label, options = {}) {
    this.issue_to = this.issue_to.bind(this);
    this.is_issued = this.is_issued.bind(this);
    this.is_expired = this.is_expired.bind(this);
    this.code = code;
    this.value = value;
    this.expiry = expiry;
    this.label = label;
    this.options = options;
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
  const switchBoard = new Conversation(robot);

  robot.listenerMiddleware((context, next, done) => {
    if (
      context.listener.options.id &&
      context.listener.options.id.match(
        new RegExp(`^token\\.[a-zA-Z0-9]+$`, "i")
      )
    ) {
      if (robot.auth.isAdmin(context.response.message.user)) {
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
    "/token create( bucket)? (\\S*)( of)?\\s?(.*)/i",
    { id: "token.bucket_create" },
    res => {
      const name = res.match[2];
      let type = res.match[4];
      type = type ? type : "";
      let success = false;
      let bucket, msg;
      switch (type.toLowerCase()) {
        case "mullvadcodes":
          bucket = new MullvadCodes();
          success = tokens.set(name, bucket);
          msg = `Added new bucket ${name} of Mullvad voucher codes.`;
          break;
        case "mullvadaccounts":
          bucket = new MullvadAccounts();
          success = tokens.set(name, bucket);
          msg = `Added new bucket ${name} of Mullvad accounts.`;
          break;
        default:
          bucket = new Bucket();
          success = tokens.set(name, bucket);
          msg = `Added new token bucket ${name}.`;
      }

      if (success) {
        res.send(msg);
      } else {
        res.send(`Token bucket ${name} already exists.`);
      }
    }
  );

  robot.respond(
    "/token destroy(?:\\sbucket)?\\s(.*)/i",
    { id: "token.bucket_destroy" },
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

  robot.respond("/token import to (.*)/i", { id: "token.import" }, res => {
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
      if (!results.data.code) {
        robot.logger.error("Invalid result: ", results);
        invalid++;
        return;
      }
      if (results.data.expiry) {
        expiry = Date.parse(String(results.data.expiry));
        expiry = !isNaN(expiry) ? expiry : null;
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
  });

  robot.respond("/token show buckets/i", { id: "token.show_buckets" }, res => {
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

  robot.respond("/token show users/i", { id: "token.show_users" }, res => {
    const response = robot.auth.usersWithRole("recipients").map(id => {
      let user = robot.brain.userForId(id);
      let name = user.name ? user.name : id;
      let issued = user._issued ? user._issued : 0;

      return `${name}: ${issued}`;
    });
    response.unshift("<User>: <# of Tokens issued>");
    if (response.length > 1) {
      res.send(response.join("\n"));
    } else {
      res.send(
        "No users available (given that you're a user, this may be an error!)."
      );
    }
  });

  robot.respond(
    "/token apply( token)?( with value)?(.*) from (.*) to (.*)/i",
    { id: "token.apply_to" },
    res => {
      const value = res.match[3];
      const bucket = res.match[4];
      const user = res.match[5];
      if (tokens.exists(bucket)) {
        const bucketObject = tokens.get(bucket);
        if (bucketObject instanceof MullvadCodes) {
          const userObject = robot.brain.userForName(user);
          if (robot.auth.hasRole(userObject, "recipients")) {
            const token = bucketObject.get_code(value);
            if (token) {
              const userObject = robot.brain.userForName(user);
              const accounts = userObject._accounts ? userObject._accounts : [];
              switch (accounts.length) {
                case 0:
                  res.send(
                    `Account ${user} has no issued Mullvad accounts to which this code can be applied.`
                  );
                  break;
                case 1:
                  if (bucketObject.apply_to(robot, userObject, 0, token)) {
                    res.send(`Applied token's value to ${user}'s account.`);
                  } else {
                    res.send(
                      `Failed to apply the token's value to ${user}'s account.`
                    );
                  }
                  break;
                default:
                  const dialog = switchBoard.startDialog(res);
                  const response = [];
                  response.push(
                    `User ${user} has the following ${accounts.length} accounts, please reply with the number of the account to which you'd like the code applied:`
                  );
                  accounts.forEach((account, index) => {
                    response.push(`${index}: ${account}`);
                    dialog.addChoice(/([0-9])+/i, msg => {
                      const choice = parseInt(msg.match[1], 10);
                      robot.logger.debug(`The choice is ${choice}.`);
                      if (accounts[choice]) {
                        if (
                          bucketObject.apply_to(
                            robot,
                            userObject,
                            choice,
                            token
                          )
                        ) {
                          msg.reply(
                            `Applied code's value to ${user}'s account.`
                          );
                        } else {
                          msg.reply(
                            `Failed to apply code's value to ${user}'s account.`
                          );
                        }
                      } else {
                        msg.reply(`${choice} is not a valid selection.`);
                      }
                    });
                  });
                  res.send(response.join("\n"));
              }
            } else {
              res.send("No valid code available.");
            }
          } else {
            res.send(`User ${user} is not a valid recipient.`);
          }
        } else {
          res.send(`Token bucket ${bucket} must be of type MullvadCodes.`);
        }
      } else {
        res.send(`Token bucket ${bucket} doesn't exist.`);
      }
    }
  );

  robot.respond(
    "/token issue (.*) token(s)? from (.*) to (.*)/i",
    { id: "token.issue" },
    res => {
      const number = res.match[1] || 1;
      const bucket = res.match[3];
      const user = res.match[4];
      if (tokens.exists(bucket)) {
        const userObject = robot.brain.userForName(user);
        if (robot.auth.hasRole(userObject, "recipients")) {
          const issued = tokens.get(bucket).issue_to(userObject, number);
          userObject.issued = userObject.issued
            ? (userObject.issued += issued)
            : issued;
          if (issued.length > 0) {
            const msg = [];
            msg.push("You have been issued the following tokens:");
            issued.forEach(t => {
              const tokenString = [];
              if (t.code != null) {
                tokenString.push(`Code: ${t.code}`);
              }
              if (t.label != null) {
                tokenString.push(` labeled ${t.label}`);
              }
              if (t.value != null) {
                tokenString.push(` with value ${t.value}`);
              }
              if (t.expiry != null && !isNaN(t.expiry)) {
                tokenString.push(` expiring ${t.expiry.toString()}`);
              }
              tokenString.join(` `);
              msg.push(tokenString);
            });
            Promise.resolve(robot.messageRoom(user, msg.join("\n"))).then(() =>
              res.send(`Sent ${issued.length} tokens to ${user}.`)
            );
          } else {
            res.send(`No tokens available in bucket ${bucket}.`);
          }
        } else {
          res.send(`User ${user} is not a valid recipient.`);
        }
      } else {
        res.send(`Token bucket ${bucket} doesn't exist.`);
      }
    }
  );
};
