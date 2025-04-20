const path = require('path');
const fs = require('fs');
const logPath = path.join(__dirname, 'bot.log');

function log(message) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] - ${message}\n`;

    fs.appendFileSync(logPath, logMessage);
    console.log(logMessage);
}

function logImageUpload(userInfo) {
    const user = `${userInfo.author.displayName} (${userInfo.author.id})`;
    log(`${user} 님이 이미지를 업로드했어요`);
}

module.exports = {
    log,
    logImageUpload
};