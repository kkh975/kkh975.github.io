const fs = require("fs");
const path = require("path");

// ============================================================================
// 파일 경로 설정
// ============================================================================

/** 입력 JSON 파일 경로 */
const inputFilePath = path.join(
  __dirname,
  "../ref",
  "kanji_merge_grade_meta_reading_scraped_llm.json"
);

/** 출력 JSON 파일 경로 */
const outputFilePath = path.join(
  __dirname,
  "../data",
  "data.json"
);

// ============================================================================
// 메인 로직
// ============================================================================

try {
  // 기존 파일이 있으면 삭제
  if (fs.existsSync(outputFilePath)) {
    fs.unlinkSync(outputFilePath);
    console.log("기존 data.json 파일을 삭제했습니다.");
  }

  // 입력 파일 읽기
  console.log("입력 파일을 읽는 중...");
  const inputData = JSON.parse(fs.readFileSync(inputFilePath, "utf8"));

  // 새로운 형식으로 데이터 구성
  const outputData = {
    version: "0.0.0",
    data: inputData
  };

  // 출력 파일에 쓰기
  console.log("출력 파일에 쓰는 중...");
  fs.writeFileSync(
    outputFilePath,
    JSON.stringify(outputData, null, 2),
    "utf8"
  );

  console.log(`성공적으로 완료되었습니다!`);
  console.log(`출력 파일: ${outputFilePath}`);
} catch (error) {
  console.error("오류가 발생했습니다:", error);
  process.exit(1);
}

