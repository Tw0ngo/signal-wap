# Signal WAP
Signal-CLI Bridge for WAP Browsers, tested on a Nokia 7110

#### I DO NOT recommend using your main account as this is a security nightmare

## How To Install
1. Install `Node.js`
2. Install [signal-cli](https://github.com/AsamK/signal-cli) and follow the Instructions to link your Signal account
3. Clone this repository
4. Open the terminal inside the folder of the repository
5. Run `npm install` to install dependencies
6. Copy `.env.example` to `.env` and edit it
7. Set the password and port in your `.env` file
8. Fix file permissions (if needed):
   ```bash
   sudo chown -R $USER:$USER
9. Run `npm start` to launch signal-wap

## Notes
- Groupchats may still be broken
- Contact names may still be broken
- Messages are stored as plaintext JSON files
- No HTTPS support - traffic is unencrypted
