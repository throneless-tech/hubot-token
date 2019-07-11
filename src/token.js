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
//   hubot list lists - list all list names
//   hubot list dump - list all list names and members
//   hubot list create <list> - create a new list
//   hubot list destroy <list> - destroy a list
//   hubot list rename <old> <new> - rename a list
//   hubot list add <list> <name> - add name to a list
//   hubot list remove <list> <name> - remove name from a list
//   hubot list info <list> - list members in list
//   hubot list membership <name> - list lists that name is in
//
// Author:
//   Josh King <jking@chambana.net>, based on hubot-group by anishathalye
//

const IDENTIFIER = "[-._a-zA-Z0-9]+";

function sorted(arr) {
  const copy = Array.from(arr);
  return copy.sort();
}

function isString(s) {
  return typeof s === 'string' || s instanceof String;
}

module.exports = robot => {
  class BucketList {
    constructor() {
      robot.brain.on("loaded", this.load);
      if (robot.brain.data.users.length) {
        this.load();
      }
    }

    load() {
      if (robot.brain.data.list) {
        this.cache = robot.brain.data.list;
      } else {
        robot.brain.data.list = this.cache;
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

    rename(from, to) {
      if (!this.exists(from) || this.exists(to)) {
        return false;
      } else {
        this.cache[to] = this.cache[from];
        delete this.cache[from];
        return true;
      }
    }
  }

  class Bucket {
    constructor() {
      this._data = new Array();
    }

    includes(token) {
      return this._data.includes(token);
    }

    push(token) {
      return this._data.push(token);
    }

    pop(token) {
      return this._data.pop(token);
    }
  }

  class Token {
    constructor(uid, worth, expiry, domain) {
      this._uid = uid;
      this._worth = worth;
      this._expiry = expiry;
      this._domain = domain;
      this._added = new Date();
      this._issued_date = null;
      this._issued_to = null;
    }

    issue_to(to) {
      this._issued_to = to;
      this._issued_data = new Date();
      return;
    }

    expired() {
      let now = new Date();
      return this._expiry.getTime() < now.getTime();
    }
  }

  robot.tokens = new BucketList();

  robot.listenerMiddleware((context, next, done) => {
    if (context.listener.options.id === "list.send") {
      if (Array.from(LIST_ADMINS).includes(context.response.message.user.id)) {
        // User is allowed access to this command
        return next();
      } else {
        // Fail silently
        return done();
      }
    } else if (
      context.listener.options.id &&
      context.listener.options.id.match(
        new RegExp(`^list\\.[a-zA-Z0-9]+$`, "i")
      )
    ) {
      if (Array.from(LIST_ADMINS).includes(context.response.message.user.id)) {
        // User is allowed access to this command
        return next();
      } else {
        // Restricted command, but user isn't in whitelist
        context.response.reply(
          `I'm sorry, @${
            context.response.message.user.name
          }, but you don't have access to do that.`
        );
        return done();
      }
    } else {
      // This is not a restricted command; allow everyone
      return next();
    }
  });

  robot.hear(new RegExp(`@${IDENTIFIER}`), { id: "list.send" }, res => {
    let mem;
    const response = [];
    const tagged = [];
    for (var g of Array.from(robot.list.lists())) {
      if (new RegExp(`(^|\\s)@${g}\\b`).test(res.message.text)) {
        tagged.push(g);
      }
    }
    if (LIST_RECURSE !== "false") {
      const process = Array.from(tagged);
      while (process.length > 0) {
        g = process.shift();
        for (mem of Array.from(robot.list.members(g))) {
          if (mem[0] === "&") {
            mem = mem.substring(1);
            // it's a list
            if (
              !Array.from(process).includes(mem) &&
              !Array.from(tagged).includes(mem)
            ) {
              tagged.push(mem);
              process.push(mem);
            }
          }
        }
      }
    }
    // output results
    const decorated = {};
    const decorateOnce = name => {
      if (name[0] === "&" || decorated[name]) {
        return name;
      } else {
        decorated[name] = true;
        return decorate(name);
      }
    };
    let { text } = res.message;
    if (LIST_PREPEND_USERNAME === "true") {
      text = `${res.message.user.name}: ${message}`;
    }
    return (() => {
      const result = [];
      for (g of Array.from(tagged)) {
        mem = robot.list.members(g);
        if (mem.length > 0) {
          if (["SlackBot", "Room"].includes(robot.adapter.constructor.name)) {
            result.push(
              (() => {
                const result1 = [];
                for (let m of Array.from(mem)) {
                  const room = robot.adapter.client.rtm.dataStore.getDMByName(
                    m
                  );
                  result1.push(res.send({ room: room.id }, text));
                }
                return result1;
              })()
            );
          } else if (["Signal"].includes(robot.adapter.constructor.name)) {
            result.push(
              (() => {
                const result1 = [];
                for (let m of Array.from(mem)) {
                  result1.push(robot.messageRoom("+" + m, text));
                }
                return result1;
              })()
            );
          } else {
            result.push(undefined);
          }
        } else {
          result.push(undefined);
        }
      }
      return result;
    })();
  });

  robot.respond(new RegExp(`[L|l]ist\\s+lists`), { id: "list.lists" }, res =>
    res.send(`Lists: ${robot.list.lists().join(", ")}`)
  );

  robot.respond(new RegExp(`[L|l]ist\\s+dump`), { id: "list.dump" }, res => {
    const response = [];
    for (let g of Array.from(robot.list.lists())) {
      response.push(`*@${g}*: ${robot.list.members(g).join(", ")}`);
    }
    if (response.length > 0) {
      res.send(response.join("\n"));
    }
  });

  robot.respond(
    new RegExp(`[L|l]ist\\s+create\\s+(${IDENTIFIER})`),
    { id: "list.create" },
    res => {
      const name = res.match[1];
      if (robot.list.create(name)) {
        res.send(`Created list ${name}.`);
      } else {
        res.send(`List ${name} already exists!`);
      }
    }
  );

  robot.respond(
    new RegExp(`[L|l]ist\\s+destroy\\s+(${IDENTIFIER})`),
    { id: "list.destroy" },
    res => {
      const name = res.match[1];
      const old = robot.list.destroy(name);
      if (old !== null) {
        res.send(`Destroyed list ${name} (${old.join(", ")}).`);
      } else {
        res.send(`List ${name} does not exist!`);
      }
    }
  );

  robot.respond(
    new RegExp(`[L|l]ist\\s+rename\\s+(${IDENTIFIER})\\s+(${IDENTIFIER})`),
    { id: "list.rename" },
    res => {
      const from = res.match[1];
      const to = res.match[2];
      if (robot.list.rename(from, to)) {
        res.send(`Renamed list ${from} to ${to}.`);
      } else {
        res.send(`Either list ${from} does not exist or ${to} already exists!`);
      }
    }
  );

  robot.respond(
    new RegExp(
      `[L|l]ist\\s+add\\s+(${IDENTIFIER})\\s+(&?${IDENTIFIER}(?:\\s+&?${IDENTIFIER})*)`
    ),
    { id: "list.add" },
    res => {
      const g = res.match[1];
      let names = res.match[2];
      names = names.split(/\s+/);
      if (!robot.list.exists(g)) {
        res.send(`List ${g} does not exist!`);
        return;
      }
      const response = [];
      for (let name of Array.from(names)) {
        if (robot.list.add(g, name)) {
          response.push(`${name} added to list ${g}.`);
        } else {
          response.push(`${name} is already in list ${g}!`);
        }
      }
      res.send(response.join("\n"));
    }
  );

  robot.respond(
    new RegExp(
      `[L|l]ist\\s+remove\\s+(${IDENTIFIER})\\s+(&?${IDENTIFIER}(?:\\s+&?${IDENTIFIER})*)`
    ),
    { id: "list.remove" },
    res => {
      const g = res.match[1];
      let names = res.match[2];
      names = names.split(/\s+/);
      if (!robot.list.exists(g)) {
        res.send(`List ${g} does not exist!`);
        return;
      }
      const response = [];
      for (let name of Array.from(names)) {
        if (robot.list.remove(g, name)) {
          response.push(`${name} removed from list ${g}.`);
        } else {
          response.push(`${name} is not in list ${g}!`);
        }
      }
      res.send(response.join("\n"));
    }
  );

  robot.respond(
    new RegExp(`[L|l]ist\\s+info\\s+(${IDENTIFIER})`),
    { id: "list.info" },
    res => {
      const name = res.match[1];
      if (!robot.list.exists(name)) {
        res.send(`List ${name} does not exist!`);
        return;
      }
      res.send(`*@${name}*: ${robot.list.members(name).join(", ")}`);
    }
  );

  robot.respond(
    new RegExp(`[L|l]ist\\s+membership\\s+(&?${IDENTIFIER})`),
    { id: "list.membership" },
    res => {
      const name = res.match[1];
      const lists = robot.list.membership(name);
      if (lists.length > 0) {
        res.send(`${name} is in ${robot.list.membership(name).join(", ")}.`);
      } else {
        res.send(`${name} is not in any lists!`);
      }
    }
  );
};
