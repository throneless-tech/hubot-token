# hubot-token
A chatbot system for managing and distributing buckets of tokens for distribution. A script that manages and distributes arbitrary buckets of tokens. Tokens are imported from CSV files, and there is special handling for account and voucher tokens for the [Mullvad VPN provider](https://mullvad.net). Requires [hubot-list](https://github.com/throneless-tech/hubot-list).

See [`src/token.js`](src/token.js) for full documentation.

## Installation

In hubot project repo, run:

`npm install @throneless/hubot-token --save`

Then add **hubot-token** to your `external-scripts.json`:

```json
[
  "@throneless/hubot-token"
]
```

## NPM Module

https://www.npmjs.com/package/@throneless/hubot-token

## License
[<img src="https://www.gnu.org/graphics/agplv3-155x51.png" alt="AGPLv3" >](http://www.gnu.org/licenses/agpl-3.0.html)

Hubot-token is a free software project licensed under the GNU Affero General Public License v3.0 (AGPLv3) by [Throneless Tech](https://throneless.tech).
