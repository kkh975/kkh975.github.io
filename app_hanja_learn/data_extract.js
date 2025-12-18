const fs = require("fs");
const path = require("path");

// data.json 파일 경로
const dataFilePath = path.join(__dirname, "data", "data.json");

// data.json 파일 읽기
console.log("Reading data.json...");
const rawData = fs.readFileSync(dataFilePath, "utf8");
const jsonData = JSON.parse(rawData);

// data 배열의 각 항목에서 id와 char만 남기고 나머지 키 제거
console.log("Processing data...");
if (jsonData.data && Array.isArray(jsonData.data)) {
  jsonData.data = jsonData.data.map((item) => {
    return {
      id: item.id,
      char: item.char,
    };
  });
  console.log(`Processed ${jsonData.data.length} items.`);
} else {
  console.error("Error: data.json does not have a valid data array.");
  process.exit(1);
}

// 수정된 데이터를 data_origin.json 파일로 저장
const outputFilePath = path.join(__dirname, "data", "data_origin.json");
console.log("Writing processed data to data_origin.json...");
fs.writeFileSync(outputFilePath, JSON.stringify(jsonData, null, 2), "utf8");

console.log("Done!");
