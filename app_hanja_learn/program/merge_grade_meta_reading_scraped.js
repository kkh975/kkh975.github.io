const fs = require("fs");
const path = require("path");
const wanakana = require("wanakana");

// 파일 경로 설정
const baseFilePath = path.join(
  __dirname,
  "../ref",
  "kanji_merge_grade_meta_reading.json"
);
const scrapFilePath = path.join(__dirname, "../ref", "scraped_kanji.json");
const outputFilePath = path.join(
  __dirname,
  "../ref",
  "kanji_merge_grade_meta_reading_scraped.json"
);

// JSON 파일 읽기
const baseData = JSON.parse(fs.readFileSync(baseFilePath, "utf8"));
const scrapData = JSON.parse(fs.readFileSync(scrapFilePath, "utf8"));

// scrap을 kanji를 키로 하는 맵으로 변환
const scrapMap = new Map();
scrapData.forEach((item) => {
  scrapMap.set(item.kanji, item);
});

// readings 항목에 기본 필드 추가하는 헬퍼 함수
const addReadingFields = (readingItem) => {
  if (!readingItem.romaji) {
    readingItem.romaji = "";
  }
  if (readingItem.isPrimary === undefined) {
    readingItem.isPrimary = false;
  }
  if (!readingItem.examples) {
    readingItem.examples = [];
  } else {
    // examples의 각 요소에 meaning.en 추가
    readingItem.examples = readingItem.examples.map((example) => {
      if (example.meaning && typeof example.meaning === "object") {
        if (!example.meaning.en) {
          example.meaning.en = "";
        }
      }
      return example;
    });
  }
  return readingItem;
};

// example의 meaning을 표준 형식으로 변환
const normalizeExampleMeaning = (example) => {
  if (typeof example === "string") {
    return { word: example, meaning: { ko: "", en: "" } };
  }
  // meaning이 있으면 en 추가
  if (example.meaning) {
    if (typeof example.meaning === "string") {
      example.meaning = { ko: example.meaning, en: "" };
    } else if (typeof example.meaning === "object" && !example.meaning.en) {
      example.meaning.en = "";
    }
  } else {
    example.meaning = { ko: "", en: "" };
  }
  return example;
};

// readings 배열을 unknown 형식으로 변환
const convertReadingsToUnknown = (readings) => {
  if (!Array.isArray(readings)) {
    return readings;
  }
  return readings.map((item) => {
    const converted = {
      kana: item.reading,
    };
    // examples가 있으면 변환
    if (item.examples && Array.isArray(item.examples)) {
      converted.examples = item.examples.map(normalizeExampleMeaning);
    } else {
      converted.examples = [];
    }
    return addReadingFields(converted);
  });
};

// scrap에 해당 kanji가 없을 때 base만 처리
const processBaseWithoutScrap = (baseItem) => {
  const resultItem = { ...baseItem };
  // readings 키를 unknown으로 변경하고 구조 변환
  if (resultItem.readings !== undefined) {
    resultItem.unknown = convertReadingsToUnknown(resultItem.readings);
    delete resultItem.readings;
  }
  return resultItem;
};

// scrap의 기본 정보를 resultItem에 추가
const addScrapBasicInfo = (resultItem, scrapItem) => {
  // scrap.url -> refUrl
  if (scrapItem.url) {
    resultItem.refUrl = scrapItem.url;
  }

  // scrap.image -> image
  if (scrapItem.image) {
    resultItem.image = scrapItem.image;
  }

  // scrap.shapeDescription -> shapeDescription
  if (scrapItem.shapeDescription) {
    const shapeDesc = { ...scrapItem.shapeDescription };
    // text가 string이면 { "ko": "..." } 형태로 변경
    if (typeof shapeDesc.text === "string") {
      shapeDesc.text = { ko: shapeDesc.text };
    }
    resultItem.shapeDescription = shapeDesc;
  }
};

// scrap의 meaning을 meanings 형식으로 변환
const processMeanings = (scrapItem, resultItem) => {
  if (scrapItem.basicInfo && scrapItem.basicInfo.meaning) {
    const meanings = {};
    const meaningArray = scrapItem.basicInfo.meaning;

    if (meaningArray.length > 0) {
      // 첫 번째 요소를 마지막 공백으로 자르기
      const firstMeaning = meaningArray[0];
      const lastSpaceIndex = firstMeaning.lastIndexOf(" ");

      if (lastSpaceIndex !== -1) {
        meanings.ko_hun = firstMeaning.substring(0, lastSpaceIndex);
        meanings.ko_eum = firstMeaning.substring(lastSpaceIndex + 1);
      } else {
        // 공백이 없으면 전체를 ko_hun으로
        meanings.ko_hun = firstMeaning;
        meanings.ko_eum = "";
      }

      // 나머지 요소들은 ko 배열로
      if (meaningArray.length > 1) {
        meanings.ko = meaningArray.slice(1);
      }
    }

    // meanings에 en 추가
    if (!meanings.en) {
      meanings.en = "";
    }
    resultItem.meanings = meanings;
  } else if (resultItem.meanings) {
    // meanings가 이미 있으면 en 추가
    if (!resultItem.meanings.en) {
      resultItem.meanings.en = "";
    }
  }
};

// description을 처리 (빈 문자열로 변환할 패턴 체크 포함)
const processDescription = (description, emptyPatterns) => {
  if (!description) {
    return { ko: "", en: "" };
  }

  if (typeof description === "string") {
    // 빈 패턴이 포함되어 있으면 빈 문자열로 설정
    if (emptyPatterns.some((pattern) => description.includes(pattern))) {
      return "";
    }
    return {
      ko: description,
      en: "",
    };
  }

  // 이미 객체인 경우
  if (!description.en) {
    description.en = "";
  }
  return description;
};

// onyomi/kunyomi의 readings를 초기화
const initializeReadings = (kanaArray) => {
  if (!kanaArray || !Array.isArray(kanaArray)) {
    return [];
  }
  return kanaArray.map((kana) =>
    addReadingFields({
      kana: kana,
      examples: [],
    })
  );
};

// representativeWords와 examples를 맵으로 변환
const buildWordsMap = (detail) => {
  const wordsMap = new Map();

  // representativeWords 처리
  if (detail.representativeWords) {
    detail.representativeWords.forEach((item) => {
      if (!wordsMap.has(item.reading)) {
        wordsMap.set(item.reading, []);
      }
      wordsMap.get(item.reading).push(...item.words);
    });
  }

  // examples 처리
  if (detail.examples) {
    detail.examples.forEach((item) => {
      if (!wordsMap.has(item.reading)) {
        wordsMap.set(item.reading, []);
      }
      wordsMap.get(item.reading).push(...item.words);
    });
  }

  return wordsMap;
};

// examples의 meaning을 표준 형식으로 변환
const normalizeExamplesMeaning = (examples) => {
  return examples.map((example) => {
    if (typeof example.meaning === "string") {
      return {
        ...example,
        meaning: { ko: example.meaning, en: "" },
      };
    } else if (example.meaning && typeof example.meaning === "object") {
      if (!example.meaning.en) {
        example.meaning.en = "";
      }
    } else {
      example.meaning = { ko: "", en: "" };
    }
    return example;
  });
};

// onyomi/kunyomi의 readings에 examples 추가
const addExamplesToReadings = (readings, wordsMap) => {
  readings.forEach((readingItem) => {
    const kana = readingItem.kana;
    if (wordsMap.has(kana)) {
      const examples = normalizeExamplesMeaning(wordsMap.get(kana));
      readingItem.examples = examples;
    }
    // examples가 없으면 빈 배열로 설정 (이미 addReadingFields에서 처리됨)
    if (!readingItem.examples) {
      readingItem.examples = [];
    }
    // romaji, isPrimary 확인
    addReadingFields(readingItem);
  });
};

// ruby 태그 제거 함수
const removeRubyTags = (text) => {
  if (typeof text !== "string") return text;
  // <ruby>...</ruby> 태그를 제거하고 내부 텍스트만 추출
  // <ruby>한자<rt>읽기</rt></ruby> 패턴을 한자로 변환
  return text.replace(/<ruby>([^<]+)<rt>[^<]*<\/rt><\/ruby>/g, "$1");
};

// examples에서 ruby 태그 제거
const removeRubyTagsFromExamples = (examples) => {
  return examples.map((example) => {
    if (example.word && typeof example.word === "string") {
      example.word = removeRubyTags(example.word);
    }
    return example;
  });
};

// meaning이 비어있는지 확인
const isEmptyMeaning = (meaning) => {
  return (
    !meaning || typeof meaning !== "object" || (!meaning.ko && !meaning.en)
  );
};

// 동일한 word가 있고 meaning이 비어있는 요소 제거
const removeEmptyMeaningDuplicates = (examples) => {
  const wordMap = new Map();
  const filteredExamples = [];

  examples.forEach((example) => {
    const word = example.word;
    if (word) {
      if (!wordMap.has(word)) {
        wordMap.set(word, []);
      }
      wordMap.get(word).push(example);
    } else {
      filteredExamples.push(example);
    }
  });

  // 각 word에 대해 meaning이 비어있지 않은 것만 유지
  wordMap.forEach((examples, word) => {
    const hasNonEmptyMeaning = examples.some(
      (ex) => !isEmptyMeaning(ex.meaning)
    );
    if (hasNonEmptyMeaning) {
      // meaning이 비어있는 요소 제거
      const validExamples = examples.filter(
        (ex) => !isEmptyMeaning(ex.meaning)
      );
      filteredExamples.push(...validExamples);
    } else {
      // 모두 비어있으면 첫 번째만 유지
      filteredExamples.push(examples[0]);
    }
  });

  return filteredExamples;
};

// readingItem의 examples 처리 (ruby 태그 제거 및 중복 제거)
const processReadingExamples = (readingItem) => {
  if (readingItem.examples && Array.isArray(readingItem.examples)) {
    readingItem.examples = removeRubyTagsFromExamples(readingItem.examples);
    readingItem.examples = removeEmptyMeaningDuplicates(readingItem.examples);
  }
};

// onyomi/kunyomi의 readings 처리 (isPrimary, romaji, examples)
const processReadings = (readings) => {
  if (!readings || !Array.isArray(readings)) {
    return;
  }

  // readings가 하나라면 isPrimary를 true로 설정
  if (readings.length === 1) {
    readings[0].isPrimary = true;
  }

  // 각 reading 처리
  readings.forEach((readingItem) => {
    // kana를 romaji로 변환
    if (readingItem.kana) {
      readingItem.romaji = wanakana.toRomaji(readingItem.kana);
    }

    // examples 처리
    processReadingExamples(readingItem);
  });
};

// onyomi와 kunyomi의 kana 수집
const collectKanas = (item) => {
  const onyomiKanas = new Set();
  const kunyomiKanas = new Set();

  if (item.onyomi && item.onyomi.readings) {
    item.onyomi.readings.forEach((reading) => {
      if (reading.kana) {
        onyomiKanas.add(reading.kana);
      }
    });
  }

  if (item.kunyomi && item.kunyomi.readings) {
    item.kunyomi.readings.forEach((reading) => {
      if (reading.kana) {
        kunyomiKanas.add(reading.kana);
      }
    });
  }

  return { onyomiKanas, kunyomiKanas };
};

// unknown 항목을 onyomi/kunyomi에 병합
const mergeUnknownToReadings = (item) => {
  if (!item.unknown || !Array.isArray(item.unknown)) {
    return;
  }

  const { onyomiKanas, kunyomiKanas } = collectKanas(item);
  const remainingUnknown = [];

  item.unknown.forEach((unknownItem) => {
    if (unknownItem.kana) {
      let matched = false;

      // onyomi에서 일치하는 kana 찾기
      if (onyomiKanas.has(unknownItem.kana)) {
        const onyomiReading = item.onyomi.readings.find(
          (r) => r.kana === unknownItem.kana
        );
        if (onyomiReading) {
          // examples 추가
          if (unknownItem.examples && Array.isArray(unknownItem.examples)) {
            if (!onyomiReading.examples) {
              onyomiReading.examples = [];
            }
            onyomiReading.examples.push(...unknownItem.examples);
          }
          matched = true;
        }
      }

      // kunyomi에서 일치하는 kana 찾기
      if (!matched && kunyomiKanas.has(unknownItem.kana)) {
        const kunyomiReading = item.kunyomi.readings.find(
          (r) => r.kana === unknownItem.kana
        );
        if (kunyomiReading) {
          // examples 추가
          if (unknownItem.examples && Array.isArray(unknownItem.examples)) {
            if (!kunyomiReading.examples) {
              kunyomiReading.examples = [];
            }
            kunyomiReading.examples.push(...unknownItem.examples);
          }
          matched = true;
        }
      }

      // 일치하지 않으면 남겨둠
      if (!matched) {
        remainingUnknown.push(unknownItem);
      }
    } else {
      // kana가 없으면 그대로 유지
      remainingUnknown.push(unknownItem);
    }
  });

  // remainingUnknown이 비어있으면 unknown 키 제거, 아니면 업데이트
  if (remainingUnknown.length === 0) {
    delete item.unknown;
  } else {
    item.unknown = remainingUnknown;
  }
};

// 결과 배열 생성
const result = baseData.map((baseItem) => {
  const scrapItem = scrapMap.get(baseItem.kanji);

  // base 항목 복사
  const resultItem = { ...baseItem };

  // scrap에 해당 kanji가 없으면 base만 반환
  if (!scrapItem) {
    return processBaseWithoutScrap(baseItem);
  }

  // scrap의 기본 정보 추가
  addScrapBasicInfo(resultItem, scrapItem);

  // meanings 처리
  processMeanings(scrapItem, resultItem);

  // base.readings 키를 unknown으로 변경하고 구조 변환
  if (resultItem.readings !== undefined) {
    resultItem.unknown = convertReadingsToUnknown(resultItem.readings);
    delete resultItem.readings;
  }

  // onyomi와 kunyomi 구조 생성
  resultItem.onyomi = {
    readings: [],
    description: "",
  };
  resultItem.kunyomi = {
    readings: [],
    description: "",
  };

  // scrap.basicInfo.onyomi -> base.onyomi.readings
  resultItem.onyomi.readings = initializeReadings(scrapItem.basicInfo?.onyomi);

  // scrap.basicInfo.kunyomi -> base.kunyomi.readings
  resultItem.kunyomi.readings = initializeReadings(
    scrapItem.basicInfo?.kunyomi
  );

  // scrap.onyomiDetail.description -> base.onyomi.description
  resultItem.onyomi.description = processDescription(
    scrapItem.onyomiDetail?.description,
    ["정식 음독은 없습니다.", "특별한 점은 없습니다."]
  );

  // scrap.kunyomiDetail.description -> base.kunyomi.description
  resultItem.kunyomi.description = processDescription(
    scrapItem.kunyomiDetail?.description,
    ["정식 훈독은 없습니다.", "특별한 점은 없습니다."]
  );

  // representativeWords와 examples 처리
  // onyomi 처리
  if (scrapItem.onyomiDetail) {
    const onyomiWordsMap = buildWordsMap(scrapItem.onyomiDetail);
    addExamplesToReadings(resultItem.onyomi.readings, onyomiWordsMap);
  }

  // kunyomi 처리
  if (scrapItem.kunyomiDetail) {
    const kunyomiWordsMap = buildWordsMap(scrapItem.kunyomiDetail);
    addExamplesToReadings(resultItem.kunyomi.readings, kunyomiWordsMap);
  }

  return resultItem;
});

// 추가 처리: 검증 전에 실행
console.log("\n추가 처리 시작...");
result.forEach((item) => {
  // onyomi 처리
  if (item.onyomi && item.onyomi.readings) {
    processReadings(item.onyomi.readings);
  }

  // kunyomi 처리
  if (item.kunyomi && item.kunyomi.readings) {
    processReadings(item.kunyomi.readings);
  }

  // unknown 처리: onyomi나 kunyomi의 readings와 일치하는 kana가 있으면 examples 추가 후 제거
  mergeUnknownToReadings(item);
});
console.log("추가 처리 완료!");

// 결과를 JSON 파일로 저장
fs.writeFileSync(outputFilePath, JSON.stringify(result, null, 2), "utf8");

console.log(`병합 완료! 총 ${result.length}개의 항목이 처리되었습니다.`);
console.log(`결과 파일: ${outputFilePath}`);

// 검증: base의 모든 kanji가 생성된 JSON에 포함되어 있는지 확인
console.log("\n검증 시작...");
const generatedData = JSON.parse(fs.readFileSync(outputFilePath, "utf8"));
const generatedKanjiSet = new Set(generatedData.map((item) => item.kanji));
const baseKanjiSet = new Set(baseData.map((item) => item.kanji));

// 누락된 kanji 찾기
const missingKanji = [];
baseKanjiSet.forEach((kanji) => {
  if (!generatedKanjiSet.has(kanji)) {
    missingKanji.push(kanji);
  }
});

// 검증 결과 출력
if (missingKanji.length === 0) {
  console.log(
    "✓ 검증 성공: base의 모든 kanji가 생성된 JSON에 포함되어 있습니다."
  );
  console.log(`  - base 항목 수: ${baseData.length}`);
  console.log(`  - 생성된 항목 수: ${generatedData.length}`);
} else {
  console.log(
    `✗ 검증 실패: ${missingKanji.length}개의 kanji가 누락되었습니다.`
  );
  console.log("누락된 kanji:", missingKanji);
  process.exit(1);
}
