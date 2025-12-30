const fs = require("fs");
const path = require("path");

// 파일 경로 설정
const gradeFilePath = path.join(__dirname, "../ref", "kanji_grade.json");
const metaFilePath = path.join(__dirname, "../ref", "kanji_meta_en.json");
const outputFilePath = path.join(
  __dirname,
  "../ref",
  "kanji_merge_grade_meta.json"
);

// JSON 파일 읽기
const kanjiGradeData = JSON.parse(fs.readFileSync(gradeFilePath, "utf8"));
const kanjiMetaData = JSON.parse(fs.readFileSync(metaFilePath, "utf8"));

// kanji_grade를 kanji를 키로 하는 맵으로 변환
const gradeMap = new Map();
kanjiGradeData.forEach((item) => {
  gradeMap.set(item.kanji, {
    grade: item.grade,
    gradeOrder: item.gradeOrder,
  });
});

// grade가 0인 항목들의 gradeOrder를 위한 카운터 (0부터 시작)
let gradeZeroCounter = -1;

// 결과 배열 생성
const result = kanjiMetaData.map((item, index) => {
  // kanji_grade에서 해당 kanji 찾기
  const gradeInfo = gradeMap.get(item.kanji);
  const grade = gradeInfo ? gradeInfo.grade : 0;

  // gradeOrder 결정
  let gradeOrder;
  if (grade !== 0) {
    // grade가 0이 아닐 때는 kanji_grade.json의 gradeOrder를 그대로 사용
    gradeOrder = gradeInfo.gradeOrder;
  } else {
    // grade가 0일 때는 0부터 순서대로
    gradeZeroCounter++;
    gradeOrder = gradeZeroCounter;
  }

  // level 객체 생성
  const level = {
    grade: grade,
    gradeOrder: gradeOrder,
    kanken: item.kankenLevel,
  };

  // radical 객체 생성
  const radical = {
    id: item.radicalId,
    kanji: item.radicalKanji,
    name: item.radicalName,
  };

  // 최종 객체 생성
  return {
    id: item.id,
    kanji: item.kanji,
    level: level,
    radical: radical,
  };
});

// 결과를 JSON 파일로 저장
fs.writeFileSync(outputFilePath, JSON.stringify(result, null, 2), "utf8");

console.log(`병합 완료! 총 ${result.length}개의 항목이 처리되었습니다.`);
console.log(`결과 파일: ${outputFilePath}`);

// 검증: meta의 모든 kanji가 생성된 JSON에 포함되어 있는지 확인
console.log("\n검증 시작...");
const generatedData = JSON.parse(fs.readFileSync(outputFilePath, "utf8"));
const generatedKanjiSet = new Set(generatedData.map((item) => item.kanji));
const metaKanjiSet = new Set(kanjiMetaData.map((item) => item.kanji));

// 누락된 kanji 찾기
const missingKanji = [];
metaKanjiSet.forEach((kanji) => {
  if (!generatedKanjiSet.has(kanji)) {
    missingKanji.push(kanji);
  }
});

// 검증 결과 출력
if (missingKanji.length === 0) {
  console.log(
    "✓ 검증 성공: meta의 모든 kanji가 생성된 JSON에 포함되어 있습니다."
  );
  console.log(`  - meta 항목 수: ${kanjiMetaData.length}`);
  console.log(`  - 생성된 항목 수: ${generatedData.length}`);
} else {
  console.log(
    `✗ 검증 실패: ${missingKanji.length}개의 kanji가 누락되었습니다.`
  );
  console.log("누락된 kanji:", missingKanji);
  process.exit(1);
}
