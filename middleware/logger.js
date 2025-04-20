const chalk = require('chalk');

const logRequest = (req, res, next) => {
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    const timestamp = new Date().toISOString();
    const method = req.method;
    const url = req.url;
    const status = res.statusCode;
    const userAgent = req.get('user-agent') || 'Unknown';
    const ip = req.ip || req.connection.remoteAddress;

    // 상태 코드에 따른 색상 설정
    let statusColor;
    if (status >= 500) statusColor = chalk.red;
    else if (status >= 400) statusColor = chalk.yellow;
    else if (status >= 300) statusColor = chalk.cyan;
    else statusColor = chalk.green;

    // 메서드에 따른 색상 설정
    let methodColor;
    switch (method) {
      case 'GET': methodColor = chalk.blue; break;
      case 'POST': methodColor = chalk.green; break;
      case 'PUT': methodColor = chalk.yellow; break;
      case 'DELETE': methodColor = chalk.red; break;
      default: methodColor = chalk.white;
    }

    console.log(
      `${chalk.gray(timestamp)} | ` +
      `${methodColor(method.padEnd(7))} | ` +
      `${statusColor(status.toString().padStart(3))} | ` +
      `${chalk.white(url)} | ` +
      `${chalk.magenta(`${duration}ms`)} | `
    );
  });

  next();
};

const logImageUpload = (req) => {
  const { description, created_at, category, messageId, userId, displayName, avatar } = req.body;
  
  console.log(chalk.cyan('\n📸 이미지 업로드 요청'));
  console.log(chalk.gray('----------------------------------------'));
  console.log(chalk.white(`설명: ${description || '없음'}`));
  console.log(chalk.white(`생성일: ${created_at}`));
  console.log(chalk.white(`카테고리: ${category || '없음'}`));
  console.log(chalk.white(`메시지ID: ${messageId}`));
  console.log(chalk.white(`사용자ID: ${userId}`));
  console.log(chalk.white(`사용자명: ${displayName}`));
  console.log(chalk.white(`아바타: ${avatar || '없음'}`));
  console.log(chalk.gray('----------------------------------------\n'));
};

const logImageList = (req, images) => {
  console.log(chalk.blue('\n📋 이미지 목록 조회'));
  console.log(chalk.gray('----------------------------------------'));
  console.log(chalk.white(`조회된 이미지 수: ${images.length}`));
  if (images.length > 0) {
    console.log(chalk.white('첫 번째 이미지 정보:'));
    console.log(chalk.white(`  - ID: ${images[0].id}`));
    console.log(chalk.white(`  - 파일명: ${images[0].filename}`));
    console.log(chalk.white(`  - 설명: ${images[0].description || '없음'}`));
  }
  console.log(chalk.gray('----------------------------------------\n'));
};

const logImageDelete = (req, data) => {
  console.log(chalk.red('\n🗑️ 이미지 삭제'));
  console.log(chalk.gray('----------------------------------------'));
  if (data.messageId) {
    console.log(chalk.white(`메시지ID: ${data.messageId}`));
    console.log(chalk.white(`삭제된 이미지 수: ${data.count}`));
  } else {
    console.log(chalk.white(`이미지ID: ${data.id}`));
    console.log(chalk.white(`파일명: ${data.filename}`));
  }
  console.log(chalk.gray('----------------------------------------\n'));
};

const logImageUpdate = (req, data) => {
  console.log(chalk.yellow('\n✏️ 이미지 설명 수정'));
  console.log(chalk.gray('----------------------------------------'));
  console.log(chalk.white(`이미지ID: ${data.id}`));
  console.log(chalk.white(`새로운 설명: ${data.description || '없음'}`));
  console.log(chalk.gray('----------------------------------------\n'));
};

module.exports = {
  logRequest,
  logImageUpload,
  logImageList,
  logImageDelete,
  logImageUpdate
}; 