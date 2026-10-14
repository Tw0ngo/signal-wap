# Signal WAP
Signal-CLI Bridge for WAP Browsers, tested on a Nokia 7110

#### I DO NOT recommend using your main account as this is a security nightmare

## How To Install
1. Install `Node.js` (18 or newer)
2. Install [signal-cli](https://github.com/AsamK/signal-cli) and follow the Instructions to link your Signal account
3. Clone this repository
4. Open the terminal inside the folder of the repository
5. Run `npm install` to install dependencies
6. Copy `.env.example` to `.env` and edit it
7. Set the password, port and your Signal number (`SIGNAL_ACCOUNT`) in your `.env` file
8. Fix file permissions (if needed): `sudo chown -R $USER:$USER .`
9. Run `npm start` to launch signal-wap
10. Point your WAP gateway (e.g. Kannel) at `http://127.0.0.1:8082/` and open it on the phone

signal-wap starts `signal-cli jsonRpc` itself and keeps it running, so don't run a
second signal-cli (daemon or cron `receive`) for the same account at the same time.

## How it fits the 7110
- Every page stays well under the ~1.4 KB compiled deck limit; long chats get an
  `Older>` link and long messages a `[more]` link. If your phone still reports the
  page as too large, lower `TEXT_BUDGET` in `.env`.
- No cookies needed: after login a short session token is carried in the links.
  Bookmark the chats page to skip the login (sessions last 30 days).
- Chats are addressed by short numbers instead of 44-character Signal ids.
- Umlauts and common emoji are turned into ASCII (`ae`, `:)`, `<3`, ...).
- Pages are sent with no-cache headers so the phone doesn't show stale chats.
- New messages are marked with `*` in the chat list.

## Notes
- Messages are stored as plaintext JSON files (`messages_store.json`, `state.json`, mode 600)
- No HTTPS support - traffic between phone and gateway is unencrypted
- Attachments are shown as `[Image]`, `[Voice]`, ... but cannot be opened
