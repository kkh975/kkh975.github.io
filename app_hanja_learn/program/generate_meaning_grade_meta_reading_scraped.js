require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { GoogleGenAI } = require("@google/genai");

// ============================================================================
// 상수 및 설정
// ============================================================================

/** 배치 처리 크기 (한 번에 LLM에 전송할 항목 수) */
// const BATCH_SIZE = 24;
const BATCH_SIZE = 178;

// ============================================================================
// 파일 경로 설정
// ============================================================================

/** 입력 JSON 파일 경로 */
const inputFilePath = path.join(
  __dirname,
  "../ref",
  "kanji_merge_grade_meta_reading_scraped.json"
);

/** 출력 JSON 파일 경로 */
const outputFilePath = path.join(
  __dirname,
  "../ref",
  "kanji_merge_grade_meta_reading_scraped_llm.json"
);

/** LLM 응답 저장 파일 경로 */
const llmResponseFilePath = path.join(__dirname, "../ref", "llm_response.txt");

// ============================================================================
// 데이터 변환 함수
// ============================================================================

/**
 * LLM에 전송할 데이터만 추출 (id, kanji, examples 포함)
 * meanings는 병합 시 원본 값 우선 사용하므로 여기서는 포함하지 않음
 * @param {Object} item - 원본 한자 데이터 항목
 * @returns {Object} LLM 전송용 간소화된 데이터
 */
function extractDataForLLM(item) {
  return {
    id: item.id,
    kanji: item.kanji,
    onyomi: {
      readings: (item.onyomi?.readings || []).map((reading) => ({
        kana: reading.kana,
        examples: reading.examples || [],
      })),
    },
    kunyomi: {
      readings: (item.kunyomi?.readings || []).map((reading) => ({
        kana: reading.kana,
        examples: reading.examples || [],
      })),
    },
    unknown: (item.unknown || []).map((item) => ({
      kana: item.kana,
      examples: item.examples || [],
    })),
  };
}

/**
 * reading 배열을 압축 형식 문자열로 변환
 * 형식: kana1[word1:ko1:en1,word2:ko2:en2];kana2[...] 또는 *kana[...] (primary)
 * @param {Array} readings - reading 배열
 * @returns {string} 압축된 문자열
 */
function compressReadings(readings) {
  if (!readings || readings.length === 0) return "";

  return readings
    .map((reading) => {
      const examplesStr = (reading.examples || [])
        .map((ex) => {
          const ko = ex.meaning?.ko || "";
          const en = ex.meaning?.en || "";
          return `${ex.word}:${ko}:${en}`;
        })
        .join(",");
      const prefix = reading.isPrimary ? "*" : "";
      return `${prefix}${reading.kana}[${examplesStr}]`;
    })
    .join(";");
}

/**
 * 데이터를 압축 형식으로 변환
 * 형식: id|kanji|ko_hun|ko_eum|ko|emoji|onyomi_readings|kunyomi_readings|unknown_readings
 * meanings 필드는 항상 빈 문자열로 보냄 (토큰 절약, 병합 시 원본 값 우선 사용)
 * @param {Object} item - LLM 전송용 데이터 항목
 * @returns {string} 압축된 한 줄 문자열
 */
function compressDataItem(item) {
  const onyomiStr = compressReadings(item.onyomi?.readings || []);
  const kunyomiStr = compressReadings(item.kunyomi?.readings || []);
  const unknownStr = compressReadings(item.unknown || []);

  // meanings 필드는 빈 문자열로 보냄
  // LLM이 채워서 응답하면, 병합 시 원본 값이 있으면 원본 사용, 없으면 LLM 값 사용
  // emoji 필드도 입력시 비어있음 (LLM이 채워줄 것)
  return `${item.id}|${item.kanji}|||||${onyomiStr}|${kunyomiStr}|${unknownStr}`;
}

// ============================================================================
// 프롬프트 생성
// ============================================================================

/**
 * 프롬프트 고정 부분 (캐싱 가능하도록 상수로 분리)
 * 프롬프트 캐싱을 위해 변수 데이터는 아래에 위치
 *
 * 프롬프트 한글 해석:
 * ============================================================================
 * 역할: 일본어 한자 데이터 처리자. 일본어 한자 데이터를 풍부화하고 특정 압축 파이프 구분 형식으로 포맷팅
 *
 * 작업 로직 (각 줄을 단계별로 처리):
 * 1. 한자 뜻 풍부화:
 *    - 한자의 한국어 뜻('ko_hun', 'ko_eum', 'ko')과 영어 뜻('en_meaning') 추가
 *    - ko_hun: 훈 (뜻, 예: 버금, 슬플)
 *    - ko_eum: 음 (소리, 예: 아, 애)
 *    - ko: 한국어 뜻 배열 (쉼표로 구분)
 *    - en_meaning: 영어 뜻
 *    - 형식: 'id|kanji|ko_hun|ko_eum|ko|emoji|en_meaning|...'
 *    - 뜻이 여러 가지라면 쉼표로 구분
 *    - 기존 값이 있으면 유지, 비어있는 경우에만 채움
 *
 * 2. 예시의 빈 뜻 채우기:
 *    - 'onyomi', 'kunyomi', 'unknown' 필드의 모든 예시 단어(word:ko:en 형식)에서
 *      빈 'ko'(한국어) 또는 'en'(영어) 필드를 채움
 *    - 기존 뜻은 변경하지 않음
 *
 * 3. Primary Readings 식별:
 *    - 'onyomi_readings'와 'kunyomi_readings' 모두에서
 *      정확히 하나의 primary reading(가장 일반적/기본적인 것)을
 *      별표('*')를 앞에 붙여 표시
 *    - 형식: '*kana[word1:ko:en,...]'
 *
 * 4. Unknown Readings 해결:
 *    - 'unknown_readings'의 kana를 'onyomi_readings'와 'kunyomi_readings'의 kana와 비교
 *    - 매칭 규칙: 괄호와 내용은 무시 (예: "あわ(れ)"는 "あわれ"로 비교)
 *    - 매칭이 발견되면: 'unknown'의 예시 단어를 매칭된 reading의 예시 목록 끝으로 이동
 *    - 중복 제거: 대상 reading 목록에 이미 단어가 있으면 추가하지 않음
 *    - 매칭이 없거나 unknown 필드가 처리되면, 무조건 최종 출력에서 비워둠
 *
 * 데이터 형식 규칙:
 * - 구조: 'id|kanji|ko_hun|ko_eum|ko|emoji|en_meaning|onyomi_readings|kunyomi_readings|unknown_readings'
 * - Readings 구분자: 세미콜론(';') - 여러 readings가 있을 때 세미콜론으로 구분
 *   예: 'kana1[word1:ko1:en1];kana2[word2:ko2:en2]'
 * - 예시 형식: 'word:ko_meaning:en_meaning'
 * - 빈 필드: 빈 문자열로 표현
 *
 * 예시:
 * - 입력:
 *   '2|哀|||슬플,애달플||アイ[哀悼:애도:,哀愁:애수:]|あわ(れ)[]|'
 *   '3|愛||||アイ[愛国:애국:,愛人:애인:]||'
 * - 출력:
 *   '2|哀|슬플|애|슬플,애달플|😢|pity, sorrow|*アイ[哀悼:애도:condolence,哀愁:애수:melancholy]|*あわれ[...]|'
 *   '3|愛|사랑|애|사랑|❤️|love|*アイ[愛国:애국:patriotism,愛人:애인:lover]||'
 *
 * 제약사항:
 * - 처리된 데이터만 반환. 소개 텍스트나 설명 없음
 * - 출력 형식: 각 한자 항목은 반드시 별도의 줄에 출력 (한 줄에 하나의 항목, 줄바꿈으로 구분)
 * - 각 줄의 파이프('|') 개수 정확히 유지
 * - 별표('*') 규칙 엄격히 준수: 읽기 타입당 딱 하나
 * ============================================================================
 */
const PROMPT_TEMPLATE = `# Role
You are a Japanese Kanji Data Processor. Your task is to enrich and format Japanese kanji data into a specific compressed pipe-delimited format.

# Task Logic (Process each line step-by-step)
1. **Enrich Kanji Meanings (Korean & English)**: 
   - Fill in any empty meaning fields for the Kanji.
   - **ko_hun**: Korean "훈" (meaning/semantic reading, e.g., 버금, 슬플)
   - **ko_eum**: Korean "음" (sound/phonetic reading, e.g., 아, 애)
   - **ko**: Korean meanings (comma-separated, e.g., 버금,아시아)
   - **en_meaning**: English meaning
   - Format: 'id|kanji|ko_hun|ko_eum|ko|emoji|en_meaning|...'
   - If there are multiple meanings, separate them with commas.
   - **Keep existing values unchanged; only fill empty fields.**

2. **Infer Emoji for Kanji**:
   - Look at the kanji character and infer an appropriate emoji that visually or conceptually represents it.
   - Place the emoji in the 'emoji' field.
   - If you cannot infer an appropriate emoji, leave the field empty.
   - Examples: 水 → 💧, 火 → 🔥, 山 → ⛰️, 愛 → ❤️, 犬 → 🐕

3. **Fill Missing Meanings in Examples**:
   - For every example word in 'onyomi', 'kunyomi', and 'unknown' fields (format 'word:ko:en'), fill in any empty 'ko' (Korean) or 'en' (English) fields. 
   - Keep existing meanings unchanged.
   - **IMPORTANT**: The 'en' (English) field in example meanings must NEVER be empty. Always provide an English translation.

4. **Identify Primary Readings**:
   - In both 'onyomi_readings' and 'kunyomi_readings', mark exactly one primary reading (the most common/basic one) by prefixing it with an asterisk ('*').
   - Format: '*kana[word1:ko:en,...]'

5. **Resolve Unknown Readings**:
   - Compare the kana in 'unknown_readings' with the kana in 'onyomi_readings' and 'kunyomi_readings'.
   - **Matching Rule**: Ignore parentheses and contents (e.g., "あわ(れ)" becomes "あわれ") during comparison.
   - If a match is found: Move the example words from 'unknown' to the end of the matching reading's example list.
   - **Deduplication**: Do not add a word if it already exists in the target reading's list.
   - If no match is found or the unknown field is processed, always keep it empty in the final output.

# Data Format Rules
- **Structure**: 'id|kanji|ko_hun|ko_eum|ko|emoji|en_meaning|onyomi_readings|kunyomi_readings|unknown_readings'
- **Readings separator**: Semicolon (';') - Multiple readings are separated by semicolons
  Example: 'kana1[word1:ko1:en1];kana2[word2:ko2:en2]'
- **Example format**: 'word:ko_meaning:en_meaning'
- **Empty fields**: Represented as an empty string.
- **CRITICAL**: Every example word MUST have a non-empty 'en_meaning'. Do not leave 'en' empty.
- **CRITICAL**: Total 10 fields = 9 pipes per line.

# Example
- **Input**: 
'2|哀|||슬플,애달플||アイ[哀悼:애도:,哀愁:애수:]|あわ(れ)[]|'
'3|愛|||||アイ[愛国:애국:,愛人:애인:]||'

- **Output**: 
'2|哀|슬플|애|슬플,애달플|😢|pity, sorrow|*アイ[哀悼:애도:condolence,哀愁:애수:melancholy]|*あわれ[哀れ:비애:pity]|'
'3|愛|사랑|애|사랑|❤️|love|*アイ[愛国:애국:patriotism,愛人:애인:lover]||'

# Constraints
- Return **ONLY** the processed data. No introductory text or explanations.
- **Output format: Each kanji entry must be on a separate line** (one entry per line, separated by newlines).
- Maintain the exact number of pipes ('|') in each line (10 fields = 9 pipes).
- Strictly follow the asterisk ('*') rule: Max one per reading type.
- **Never leave 'en' empty in example meanings**.
- **Keep existing Korean meanings (ko_hun, ko_eum, ko) unchanged; only fill if empty.**

# Input Data`;

// ============================================================================
// 압축 형식 파싱
// ============================================================================

/**
 * 압축 형식의 readings 문자열을 파싱
 * 형식: kana[word1:ko1:en1,word2:ko2:en2];kana2[...] 또는 *kana[...] (primary)
 * @param {string} readingsStr - 압축된 readings 문자열
 * @returns {Array} reading 배열
 */
function parseReadings(readingsStr) {
  if (!readingsStr || readingsStr.trim() === "") return [];

  return readingsStr.split(";").map((readingStr) => {
    // primary 표시 확인 (*kana[...])
    const isPrimary = readingStr.trim().startsWith("*");
    const cleanStr = isPrimary
      ? readingStr.trim().substring(1)
      : readingStr.trim();

    const match = cleanStr.match(/^([^[]+)\[(.*)\]$/);
    if (!match) {
      return { kana: cleanStr, examples: [], isPrimary };
    }

    const kana = match[1].trim();
    const examplesStr = match[2];

    const examples = examplesStr
      ? examplesStr.split(",").map((exStr) => {
          const parts = exStr.split(":");
          const word = parts[0] || "";
          const ko = parts[1] || "";
          const en = parts[2] || "";
          return {
            word,
            meaning: { ko, en },
          };
        })
      : [];

    return { kana, examples, isPrimary };
  });
}

/**
 * 압축 형식 문자열을 파싱하여 JSON 객체로 변환
 * 형식: id|kanji|ko_hun|ko_eum|ko|emoji|en_meaning|onyomi_readings|kunyomi_readings|unknown_readings
 * @param {string} compressedData - 압축된 데이터 문자열 (여러 줄)
 * @returns {Array} 파싱된 데이터 배열
 */
function parseCompressedData(compressedData) {
  const lines = compressedData
    .trim()
    .split("\n")
    .filter((line) => line.trim());
  return lines.map((line) => {
    const parts = line.split("|");

    // 새 형식: 10개 필드 (id|kanji|ko_hun|ko_eum|ko|emoji|en_meaning|onyomi|kunyomi|unknown)
    if (parts.length >= 10) {
      const [
        id,
        kanji,
        koHun,
        koEum,
        koStr,
        emoji,
        enMeaning,
        onyomiStr,
        kunyomiStr,
        unknownStr,
      ] = parts;
      // ko는 쉼표로 구분된 배열
      const koArr = koStr
        ? koStr
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s)
        : [];
      return {
        id: parseInt(id, 10),
        kanji,
        emoji: emoji || "",
        meanings: {
          ko_hun: koHun || "",
          ko_eum: koEum || "",
          ko: koArr,
          en: enMeaning || "",
        },
        onyomi: { readings: parseReadings(onyomiStr || "") },
        kunyomi: { readings: parseReadings(kunyomiStr || "") },
        unknown: parseReadings(unknownStr || ""),
      };
    }

    // 기존 형식 지원 (7개 필드: id|kanji|emoji|en_meaning|onyomi|kunyomi|unknown)
    if (parts.length >= 7) {
      const [id, kanji, emoji, enMeaning, onyomiStr, kunyomiStr, unknownStr] =
        parts;
      return {
        id: parseInt(id, 10),
        kanji,
        emoji: emoji || "",
        meanings: { ko_hun: "", ko_eum: "", ko: [], en: enMeaning || "" },
        onyomi: { readings: parseReadings(onyomiStr || "") },
        kunyomi: { readings: parseReadings(kunyomiStr || "") },
        unknown: parseReadings(unknownStr || ""),
      };
    }

    // 최소 형식 (5개 이하)
    const [id, kanji, onyomiStr, kunyomiStr, unknownStr] = parts;
    return {
      id: parseInt(id, 10),
      kanji,
      emoji: "",
      meanings: { ko_hun: "", ko_eum: "", ko: [], en: "" },
      onyomi: { readings: parseReadings(onyomiStr || "") },
      kunyomi: { readings: parseReadings(kunyomiStr || "") },
      unknown: parseReadings(unknownStr || ""),
    };
  });
}

// ============================================================================
// LLM 호출
// ============================================================================

/**
 * LLM 응답 텍스트에서 압축 형식 데이터 추출 (마크다운 코드 블록 제거)
 * @param {string} text - LLM 응답 텍스트
 * @returns {string} 추출된 압축 형식 문자열
 */
function extractCompressedDataFromResponse(text) {
  let dataText = text.trim();
  // 마크다운 코드 블록 제거
  if (dataText.startsWith("```")) {
    dataText = dataText.replace(/^```[a-z]*\s*/, "").replace(/\s*```$/, "");
  }
  return dataText;
}

// ============================================================================
// 데이터 병합 함수
// ============================================================================

/**
 * example의 meaning 업데이트 (ko, en) - 불변성 유지
 * @param {Object} existingExample - 기존 example 객체
 * @param {Object} llmExample - LLM 응답의 example 객체
 * @returns {Object} 업데이트된 example 객체
 */
function updateExampleMeaning(existingExample, llmExample) {
  if (!llmExample.meaning) {
    return { ...existingExample };
  }

  return {
    ...existingExample,
    meaning: {
      ...existingExample.meaning,
      ko: llmExample.meaning.ko || existingExample.meaning?.ko || "",
      en: llmExample.meaning.en || existingExample.meaning?.en || "",
    },
  };
}

/**
 * reading의 examples 업데이트 또는 추가 - 불변성 유지
 * @param {Object} existingReading - 기존 reading 객체
 * @param {Object} llmReading - LLM 응답의 reading 객체
 * @returns {Array} 업데이트된 examples 배열
 */
function updateReadingExamples(existingReading, llmReading) {
  if (!llmReading.examples || llmReading.examples.length === 0) {
    return existingReading.examples || [];
  }

  const examplesMap = new Map();
  // 기존 examples를 맵에 추가
  (existingReading.examples || []).forEach((ex) => {
    examplesMap.set(ex.word, ex);
  });

  // LLM examples로 업데이트
  llmReading.examples.forEach((llmExample) => {
    const existingExample = examplesMap.get(llmExample.word);
    if (existingExample) {
      // 기존 example의 meaning 업데이트
      examplesMap.set(
        llmExample.word,
        updateExampleMeaning(existingExample, llmExample)
      );
    } else {
      // 새로운 example 추가
      examplesMap.set(llmExample.word, llmExample);
    }
  });

  return Array.from(examplesMap.values());
}

/**
 * readings 업데이트 - 불변성 유지 (onyomi/kunyomi용)
 * @param {Array} originalReadings - 원본 readings 배열
 * @param {Array} llmReadings - LLM 응답 readings 배열
 * @param {Array} originalBatchReadings - 원본 배치 readings 배열 (romaji 등 메타데이터 참조용)
 * @param {string} description - 기존 description
 * @returns {Object} readings 객체 {readings: Array, description: string}
 */
function updateReadings(
  originalReadings,
  llmReadings,
  originalBatchReadings,
  description
) {
  if (!llmReadings || llmReadings.length === 0) {
    return { readings: originalReadings || [], description: description || "" };
  }

  // onyomi/kunyomi: 기존 readings와 병합
  const readingsMap = new Map();
  // 기존 readings를 맵에 추가
  (originalReadings || []).forEach((r) => {
    readingsMap.set(r.kana, r);
  });

  // LLM readings로 업데이트
  llmReadings.forEach((llmReading) => {
    const existingReading = readingsMap.get(llmReading.kana);
    if (existingReading) {
      // 기존 reading의 examples 업데이트
      readingsMap.set(llmReading.kana, {
        ...existingReading,
        examples: updateReadingExamples(existingReading, llmReading),
      });
    } else {
      // 새로운 reading 추가 (원본 구조에서 romaji 찾기)
      const originalReading = originalBatchReadings?.find(
        (r) => r.kana === llmReading.kana
      );
      readingsMap.set(llmReading.kana, {
        kana: llmReading.kana,
        examples: llmReading.examples || [],
        romaji: originalReading?.romaji || "",
        isPrimary: originalReading?.isPrimary || false,
      });
    }
  });

  return {
    readings: Array.from(readingsMap.values()),
    description: description || "",
  };
}

/**
 * meanings.en을 배열로 변환 (쉼표로 분리)
 * @param {string} enValue - 영어 뜻 문자열
 * @returns {Array} 분리된 배열
 */
function convertEnMeaningToArray(enValue) {
  if (!enValue || typeof enValue !== "string") {
    return [];
  }
  return enValue
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * visualData 객체 생성
 * @param {string} emoji - LLM이 추론한 이모지
 * @returns {Object} visualData 객체
 */
function createVisualData(emoji) {
  if (emoji && emoji.trim() !== "") {
    return {
      type: "emoji",
      value: emoji.trim(),
    };
  }
  return {
    type: "image",
    value: "",
  };
}

/**
 * 단일 항목에 LLM 응답 병합 - 불변성 유지
 * @param {Object} originalItem - 원본 항목
 * @param {Object} llmItem - LLM 응답 항목
 * @param {Object} originalBatchItem - 원본 배치 항목 (메타데이터 참조용)
 * @returns {Object} 병합된 새로운 항목 객체
 */
function mergeSingleItem(originalItem, llmItem, originalBatchItem) {
  if (!llmItem) {
    throw new Error("llmItem 없음");
  }

  // unknown 필드를 제외한 나머지 필드 추출
  const { unknown, ...restOriginalItem } = originalItem;

  // meanings.en 배열로 변환
  const enMeaning = llmItem.meanings?.en || originalItem.meanings?.en || "";
  const enArray = convertEnMeaningToArray(enMeaning);

  // meanings.ko 병합 (원본이 비어있으면 LLM 값 사용)
  const originalKo = originalItem.meanings?.ko || [];
  const llmKo = llmItem.meanings?.ko || [];
  const mergedKo =
    originalKo.length > 0
      ? originalKo
      : Array.isArray(llmKo)
      ? llmKo
      : typeof llmKo === "string" && llmKo
      ? llmKo
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s)
      : [];

  // meanings.ko_hun 병합 (원본이 비어있으면 LLM 값 사용)
  const mergedKoHun =
    originalItem.meanings?.ko_hun || llmItem.meanings?.ko_hun || "";

  // meanings.ko_eum 병합 (원본이 비어있으면 LLM 값 사용)
  const mergedKoEum =
    originalItem.meanings?.ko_eum || llmItem.meanings?.ko_eum || "";

  // visualData 생성
  const visualData = createVisualData(llmItem.emoji);

  // shapeDescription 위에 visualData를 넣기 위해 객체 재구성
  const result = {};
  for (const key of Object.keys(restOriginalItem)) {
    if (key === "shapeDescription") {
      result.visualData = visualData;
    }
    result[key] = restOriginalItem[key];
  }
  // shapeDescription이 없는 경우에도 visualData 추가
  if (!result.visualData) {
    result.visualData = visualData;
  }

  return {
    ...result,
    meanings: {
      ko_hun: mergedKoHun,
      ko_eum: mergedKoEum,
      ko: mergedKo,
      en: enArray,
    },
    onyomi: updateReadings(
      originalItem.onyomi?.readings,
      llmItem.onyomi?.readings,
      originalBatchItem.onyomi?.readings,
      originalItem.onyomi?.description
    ),
    kunyomi: updateReadings(
      originalItem.kunyomi?.readings,
      llmItem.kunyomi?.readings,
      originalBatchItem.kunyomi?.readings,
      originalItem.kunyomi?.description
    ),
  };
}

// ============================================================================
// 배치 처리 함수
// ============================================================================

/**
 * 단일 배치 처리
 * @param {Object} ai - GoogleGenAI 클라이언트 인스턴스
 * @param {Array} batch - 처리할 배치 데이터
 * @param {number} batchIndex - 배치 인덱스 (0부터 시작)
 * @returns {Promise<Array>} 처리된 배치 데이터
 * @throws {Error} 처리 실패 시
 */
async function processBatch(ai, batch, batchIndex) {
  // 전송할 데이터 추출 및 압축 형식으로 변환
  const dataForLLM = batch.map(extractDataForLLM);
  const compressedData = dataForLLM.map(compressDataItem).join("\n");
  const prompt = `${PROMPT_TEMPLATE}
${compressedData}`;

  console.log(compressedData);

  // LLM 호출
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: prompt,
    });

    // 원본 텍스트 저장
    const rawText = response.text;

    // LLM 원본 텍스트 응답 저장
    saveLLMResponse(batchIndex, rawText);

    // 압축 형식 데이터 추출 (마크다운 코드 블록 제거)
    const compressedDataFromResponse =
      extractCompressedDataFromResponse(rawText);
    const parsedData = parseCompressedData(compressedDataFromResponse);

    // 응답과 원본 데이터 병합 (불변성 유지)
    const processedBatch = batch.map((originalBatchItem, j) => {
      const llmItem = parsedData[j];
      return mergeSingleItem(originalBatchItem, llmItem, originalBatchItem);
    });

    return processedBatch;
  } catch (error) {
    console.error("LLM 호출 오류:", error);
    throw error;
  }
}

/**
 * LLM 응답을 파일에 저장 (원본 텍스트 그대로 기존 파일에 이어서 저장)
 * @param {number} batchIndex - 배치 인덱스 (0부터 시작)
 * @param {string} rawText - LLM 원본 텍스트 응답
 */
function saveLLMResponse(batchIndex, rawText) {
  try {
    // 기존 파일에 이어서 쓰기 (append 모드)
    // 첫 번째 배치가 아니면 앞에 줄바꿈 추가
    const content = batchIndex === 0 ? rawText : "\n" + rawText;
    fs.appendFileSync(llmResponseFilePath, content, "utf8");
  } catch (error) {
    console.error(`LLM 응답 저장 중 오류 발생 (배치 ${batchIndex}):`, error);
    // 오류가 발생해도 처리는 계속 진행
  }
}

/**
 * API 호출 간 대기
 * @param {number} delayMs - 대기 시간 (밀리초)
 */
async function waitForApiDelay(delayMs) {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

// ============================================================================
// 스크립트 실행
// ============================================================================

/**
 * 메인 실행 함수
 */
async function main() {
  try {
    // 데이터 읽기
    console.log("데이터 파일 읽는 중...");
    const allData = JSON.parse(fs.readFileSync(inputFilePath, "utf8"));
    console.log(`총 ${allData.length}개의 항목을 처리합니다.`);

    // Gemini API 초기화
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
    if (!GEMINI_API_KEY) {
      console.error("GEMINI_API_KEY 환경변수를 설정해주세요.");
      process.exit(1);
    }
    const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

    // 배치로 나누기
    const batches = Array.from(
      { length: Math.ceil(allData.length / BATCH_SIZE) },
      (_, i) => allData.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE)
    );
    console.log(`${batches.length}개의 배치로 나뉩니다.`);

    // 각 배치 처리 (순차적으로)
    for await (const [i, batch] of batches.entries()) {
      const batchStartIndex = i * BATCH_SIZE;

      console.log(
        `\n[${i + 1}/${batches.length}] 배치 처리 중... (${
          batch.length
        }개 항목)`
      );
      console.log("LLM 호출 중...");

      try {
        const processedBatch = await processBatch(ai, batch, i);

        // 처리된 배치로 교체
        for (let j = 0; j < processedBatch.length; j++) {
          allData[batchStartIndex + j] = processedBatch[j];
        }

        console.log(`배치 ${i + 1} 처리 완료`);

        // 응답이 오면 바로바로 저장
        fs.writeFileSync(
          outputFilePath,
          JSON.stringify(allData, null, 2),
          "utf8"
        );

        // API 호출 제한을 위한 대기
        await waitForApiDelay(1000);
      } catch (error) {
        console.error(`배치 ${i + 1} 처리 중 오류 발생:`, error);
        // 오류 발생 시에도 계속 진행
      }
    }

    console.log(`\n처리 완료! 결과가 ${outputFilePath}에 저장되었습니다.`);
  } catch (error) {
    console.error("처리 중 오류 발생:", error);
    process.exit(1);
  }
}

// 스크립트 실행
main();
