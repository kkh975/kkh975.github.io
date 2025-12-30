const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

// 파일 경로 설정
const jsonFilePath = path.join(
  __dirname,
  "../ref",
  "kanji_merge_grade_meta_reading_scraped.json"
);
const imagesDir = path.join(__dirname, "../data/kanji_images");

// 이미지 디렉토리가 없으면 생성
if (!fs.existsSync(imagesDir)) {
  fs.mkdirSync(imagesDir, { recursive: true });
}

// 이미지 다운로드 함수
const downloadImage = (url, filePath) => {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith("https") ? https : http;

    protocol
      .get(url, (response) => {
        // 리다이렉션 처리
        if (
          response.statusCode === 301 ||
          response.statusCode === 302 ||
          response.statusCode === 307 ||
          response.statusCode === 308
        ) {
          return downloadImage(response.headers.location, filePath)
            .then(resolve)
            .catch(reject);
        }

        if (response.statusCode !== 200) {
          reject(
            new Error(
              `Failed to download image: ${response.statusCode} ${response.statusMessage}`
            )
          );
          return;
        }

        const fileStream = fs.createWriteStream(filePath);
        response.pipe(fileStream);

        fileStream.on("finish", () => {
          fileStream.close();
          resolve();
        });

        fileStream.on("error", (err) => {
          fs.unlink(filePath, () => {}); // 실패한 파일 삭제
          reject(err);
        });
      })
      .on("error", (err) => {
        reject(err);
      });
  });
};

// 1초 대기 함수
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 메인 함수
const main = async () => {
  try {
    console.log("JSON 파일 읽는 중...");
    const jsonData = JSON.parse(fs.readFileSync(jsonFilePath, "utf8"));
    console.log(`총 ${jsonData.length}개의 항목을 찾았습니다.`);

    let successCount = 0;
    let failCount = 0;

    // 순차적으로 처리 (for-await-of 사용)
    for await (const item of jsonData) {
      if (!item.image || !item.id || !item.kanji) {
        console.log(
          `건너뜀: id=${item.id}, kanji=${item.kanji} (image URL이 없습니다)`
        );
        continue;
      }

      const fileName = `${item.id}_${item.kanji}.png`;
      const filePath = path.join(imagesDir, fileName);

      // 이미 파일이 존재하면 건너뛰기
      if (fs.existsSync(filePath)) {
        console.log(`이미 존재: ${fileName}`);
        continue;
      }

      try {
        console.log(`다운로드 중: ${fileName} (${item.image})`);
        await downloadImage(item.image, filePath);
        console.log(`완료: ${fileName}`);
        successCount++;

        // 1초 대기
        await sleep(1000);
      } catch (error) {
        console.error(`실패: ${fileName} - ${error.message}`);
        failCount++;
        // 실패해도 1초 대기
        await sleep(1000);
      }
    }

    console.log("\n=== 다운로드 완료 ===");
    console.log(`성공: ${successCount}개`);
    console.log(`실패: ${failCount}개`);
  } catch (error) {
    console.error("오류 발생:", error);
    process.exit(1);
  }
};

main();
