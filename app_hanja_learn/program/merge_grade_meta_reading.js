const fs = require("fs");
const path = require("path");

// 파일 경로 설정
const mergeGradeMetaFilePath = path.join(
  __dirname,
  "../ref",
  "kanji_merge_grade_meta.json"
);
const readingFilePath = path.join(
  __dirname,
  "../ref",
  "kanji_reading_ex_en.json"
);
const outputFilePath = path.join(
  __dirname,
  "../ref",
  "kanji_merge_grade_meta_reading.json"
);

// JSON 파일 읽기
const mergeGradeMetaData = JSON.parse(
  fs.readFileSync(mergeGradeMetaFilePath, "utf8")
);
const readingData = JSON.parse(fs.readFileSync(readingFilePath, "utf8"));

// kanji_reading_ex_en을 kanji를 키로 하는 맵으로 변환
// kanji 배열에 포함된 모든 한자를 키로 사용
const readingMap = new Map();
readingData.forEach((item) => {
  item.kanji.forEach((kanji) => {
    readingMap.set(kanji, item.readings);
  });
});

// 결과 배열 생성
const result = mergeGradeMetaData.map((item) => {
  // kanji_reading_ex_en에서 해당 kanji 찾기
  const readings = readingMap.get(item.kanji);

  // 최종 객체 생성
  const resultItem = {
    id: item.id,
    kanji: item.kanji,
    level: item.level,
    radical: item.radical,
  };

  // readings가 있으면 최상위 항목에 추가
  if (readings) {
    resultItem.readings = readings;
  }

  return resultItem;
});

// 결과를 JSON 파일로 저장
fs.writeFileSync(outputFilePath, JSON.stringify(result, null, 2), "utf8");

console.log(`병합 완료! 총 ${result.length}개의 항목이 처리되었습니다.`);
console.log(`결과 파일: ${outputFilePath}`);

// 검증: merge_grade_meta의 모든 kanji가 생성된 JSON에 포함되어 있는지 확인
console.log("\n검증 시작...");
const generatedData = JSON.parse(fs.readFileSync(outputFilePath, "utf8"));
const generatedKanjiSet = new Set(generatedData.map((item) => item.kanji));
const mergeGradeMetaKanjiSet = new Set(
  mergeGradeMetaData.map((item) => item.kanji)
);

// 누락된 kanji 찾기
const missingKanji = [];
mergeGradeMetaKanjiSet.forEach((kanji) => {
  if (!generatedKanjiSet.has(kanji)) {
    missingKanji.push(kanji);
  }
});

// 검증 결과 출력
if (missingKanji.length === 0) {
  console.log(
    "✓ 검증 성공: merge_grade_meta의 모든 kanji가 생성된 JSON에 포함되어 있습니다."
  );
  console.log(`  - merge_grade_meta 항목 수: ${mergeGradeMetaData.length}`);
  console.log(`  - 생성된 항목 수: ${generatedData.length}`);
} else {
  console.log(
    `✗ 검증 실패: ${missingKanji.length}개의 kanji가 누락되었습니다.`
  );
  console.log("누락된 kanji:", missingKanji);
  process.exit(1);
}

