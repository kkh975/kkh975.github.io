/**
 * 한자 단어 예문 생성기 (OpenAI Structured Output)
 * - JSON 데이터에서 id별 word를 추출
 * - 최소 15개 word가 되도록 여러 id를 묶어 배치 구성
 * - OpenAI API로 예문 생성 (structured output / zod)
 * - 검증 후 누락된 단어만 재요청하여 병합
 * - 입력 구조를 미러링한 JSON 저장
 *
 * 필요: npm install openai zod
 * 실행: OPENAI_API_KEY=sk-... node generate_examples.js
 */
require("dotenv").config();
const fs = require("fs/promises");
const path = require("path");
const OpenAI = require("openai");
const { z } = require("zod");
const { zodResponseFormat } = require("openai/helpers/zod");

// ─── 1. Structured Output 스키마 정의 (zod) ───

const WordExample = z.object({
  word: z.string().describe("원본 단어"),
  example_sentence: z.string().describe("일본어 예문"),
  example_meaning_ko: z.string().describe("예문의 한국어 번역"),
  example_meaning_en: z.string().describe("예문의 영어 번역"),
});

const BatchResult = z.object({
  examples: z.array(WordExample),
});

const CorruptedWordFix = z.object({
  key: z.string().describe("요청 항목 고유 키"),
  corrected_word: z.string().describe("추정한 일본어 단어/표현"),
});

const CorruptedWordFixBatchResult = z.object({
  fixes: z.array(CorruptedWordFix),
});

// ─── 2. 시스템 프롬프트 ───

const SYSTEM_PROMPT = `당신은 일본어 교육 전문가입니다.
주어진 일본어 단어 각각에 대해 예문을 생성해주세요.

규칙:
- 각 단어당 최소 1개, 최대 2개의 예문을 만드세요.
- 예문은 일상 대화에서 쓸만한 것이 우선순위가 높습니다.
- 어려운 단어여서 일상생활에서 쓰이기 어려운 단어라면, 뉴스 본문에 쓸만한 예문이라도 무관합니다. 단어 난이도에 맞게 자연스럽게 작성하세요.
- example_meaning_ko는 예문의 한국어 번역입니다.
- example_meaning_en은 예문의 영어 번역입니다.
- 반드시 모든 단어에 대해 빠짐없이 예문을 생성하세요. 누락이 있으면 안 됩니다.`;

const FIX_WORD_SYSTEM_PROMPT = `당신은 일본어 어휘 정제 전문가입니다.
오염된 word(한글/영문 혼입)를 일본어 표기(한자/가나)로 복원하세요.

규칙:
- corrected_word에는 일본어 표기만 넣으세요.
- 한글(가-힣)과 영문(a-zA-Z)은 corrected_word에 포함하지 마세요.
- 입력의 kana와 meaning(ko/en), kanji 문맥을 함께 참고해 가장 자연스러운 단어/표현으로 복원하세요.
- 복원 확신이 낮거나 복원이 불가능하면 임의로 추정하지 말고 corrected_word를 빈 문자열로 두세요.
- key는 반드시 입력과 동일하게 반환하세요.`;

// ─── 3. 데이터에서 word 추출 ───

/**
 * @doc 원본 데이터에서 배치 처리용 단어 목록을 id 단위로 추출한다.
 * @param {Array} data 한자 엔트리 배열
 * @returns {Array<{id:number, words:Array<{id:number, word:string, meaning_ko:string}>}>}
 */
function groupWordsForBatching(data) {
  return data.map((entry) => {
    const words = [];
    // 이후 실패 판정/부분 덮어쓰기를 id 단위로 하기 때문에
    // word 객체에 entry.id를 함께 넣어 추적 가능하게 만든다.
    for (const reading of entry.onyomi?.readings ?? []) {
      for (const ex of reading.examples ?? []) {
        words.push({
          id: entry.id,
          word: ex.word,
          meaning_ko: ex.meaning?.ko ?? "",
        });
      }
    }
    for (const reading of entry.kunyomi?.readings ?? []) {
      for (const ex of reading.examples ?? []) {
        words.push({
          id: entry.id,
          word: ex.word,
          meaning_ko: ex.meaning?.ko ?? "",
        });
      }
    }
    return { id: entry.id, words };
  });
}

// ─── 4. 배치 구성 (최소 minWords개) ───

/**
 * @doc id 묶음을 최소 단어 수 기준으로 배치화한다.
 * @param {Array<{id:number, words:Array}>} wordsById id별 단어 목록
 * @param {number} [minWords=15] 배치 최소 단어 수
 * @returns {Array<{ids:number[], words:Array}>}
 */
function createBatches(wordsById, minWords = 15) {
  const batches = [];
  let currentIds = [];
  let currentWords = [];

  // 요청 비용/지연을 줄이기 위해 여러 id를 한 번에 묶되,
  // batch 단위 재시도가 가능하도록 ids 목록을 함께 유지한다.
  for (const entry of wordsById) {
    currentIds.push(entry.id);
    currentWords.push(...entry.words);

    if (currentWords.length >= minWords) {
      batches.push({ ids: [...currentIds], words: [...currentWords] });
      currentIds = [];
      currentWords = [];
    }
  }

  if (currentWords.length > 0) {
    if (batches.length > 0 && currentWords.length < minWords) {
      // 마지막 배치가 너무 작으면 직전 배치에 합쳐
      // 지나치게 작은 요청이 생기지 않게 한다.
      const last = batches[batches.length - 1];
      last.ids.push(...currentIds);
      last.words.push(...currentWords);
    } else {
      batches.push({ ids: currentIds, words: currentWords });
    }
  }

  return batches;
}

/**
 * @doc 배치 배열을 순차 소비 가능한 제너레이터 형태로 래핑한다.
 * @param {Array<{ids:number[], words:Array}>} batches 배치 목록
 * @yields {{index:number, batch:{ids:number[], words:Array}}}
 */
function* createBatchSequence(batches) {
  for (let i = 0; i < batches.length; i++) {
    yield { index: i, batch: batches[i] };
  }
}

/**
 * @doc 재시도 횟수를 제너레이터로 제공한다.
 * @param {number} maxRetries 최대 재시도 횟수
 * @yields {number}
 */
function* createRetrySequence(maxRetries) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    yield attempt;
  }
}

/**
 * @doc 배치 제너레이터를 재귀적으로 끝까지 소비한다.
 * @param {Generator} batchSequence createBatchSequence 결과
 * @param {(value:{index:number, batch:{ids:number[], words:Array}})=>Promise<void>} handler 배치 처리 함수
 * @returns {Promise<void>}
 */
async function consumeBatchSequence(batchSequence, handler) {
  const { value, done } = batchSequence.next();
  if (done) return;
  await handler(value);
  await consumeBatchSequence(batchSequence, handler);
}

/**
 * @doc 누락 단어만 재요청하면서 결과를 누적한다.
 * @param {Generator} retrySequence createRetrySequence 결과
 * @param {Array<{id:number, word:string, meaning_ko:string}>} requestedWords 원요청 단어 목록
 * @param {Array<{word:string, example_sentence:string, example_meaning_ko:string, example_meaning_en:string}>} allExamples 현재까지 누적된 결과
 * @param {OpenAI} client OpenAI 클라이언트
 * @param {string} model 호출 모델명
 * @param {number} maxRetries 최대 재시도 횟수(로그 출력용)
 * @returns {Promise<Array<{word:string, example_sentence:string, example_meaning_ko:string, example_meaning_en:string}>>}
 */
async function consumeRetrySequence(
  retrySequence,
  requestedWords,
  allExamples,
  client,
  model,
  maxRetries,
) {
  const { value: attempt, done } = retrySequence.next();
  if (done) return allExamples;

  // 현재까지 수집한 결과를 기준으로 누락 단어를 계산한다.
  // 재시도에서는 "누락분만" 요청해서 토큰 사용량을 줄인다.
  const coveredWords = new Set(allExamples.map((ex) => ex.word));
  const missing = requestedWords.filter((w) => !coveredWords.has(w.word));

  if (missing.length === 0) return allExamples;

  console.log(
    `    ⚠ 누락 ${missing.length}개 발견 → 재시도 ${attempt}/${maxRetries}: ` +
      `[${missing.map((w) => w.word).join(", ")}]`,
  );

  try {
    const retryResult = await callOpenAI(client, missing, model);
    // 기존 결과를 유지한 채로 누적한다.
    // 동일 word가 중복될 수 있지만, downstream 구조는 word별 sentences 배열이므로 문제없다.
    allExamples.push(...retryResult.examples);
    return consumeRetrySequence(
      retrySequence,
      requestedWords,
      allExamples,
      client,
      model,
      maxRetries,
    );
  } catch (err) {
    console.error(`    ✗ 재시도 실패: ${err.message}`);
    return allExamples;
  }
}

// ─── 5. OpenAI 예문 생성 ───

/**
 * @doc 단어 목록을 Structured Output으로 예문 생성 요청한다.
 * @param {OpenAI} client OpenAI 클라이언트
 * @param {Array<{id:number, word:string, meaning_ko:string}>} words 요청 단어 목록
 * @param {string} model 호출 모델명
 * @returns {Promise<{examples:Array<{word:string, example_sentence:string, example_meaning_ko:string, example_meaning_en:string}>}>}
 */
async function callOpenAI(client, words, model) {
  const wordListStr = words
    .map((w) => `- ${w.word} (${w.meaning_ko})`)
    .join("\n");

  const response = await client.chat.completions.parse({
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `다음 단어들의 예문을 만들어주세요:\n${wordListStr}`,
      },
    ],
    response_format: zodResponseFormat(BatchResult, "batch_result"),
  });

  return response.choices[0].message.parsed;
}

/**
 * @doc 단일 문자가 일본어 단어 표기에 허용되는 문자 범위인지 판정한다.
 * @param {string} char 단일 문자
 * @returns {boolean}
 */
function isAllowedJapaneseWordChar(char) {
  if (!char) return false;
  const cp = char.codePointAt(0);

  // Kanji (CJK Unified Ideographs + Ext A)
  if ((cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff)) {
    return true;
  }
  // Hiragana
  if (cp >= 0x3040 && cp <= 0x309f) return true;
  // Katakana + phonetic extensions
  if (
    (cp >= 0x30a0 && cp <= 0x30ff) ||
    (cp >= 0x31f0 && cp <= 0x31ff) ||
    (cp >= 0xff66 && cp <= 0xff9f)
  ) {
    return true;
  }
  // Japanese punctuation/symbols frequently used in word/sentence-like examples
  if (
    cp === 0x3005 || // 々
    cp === 0x3006 || // 〆
    cp === 0x3007 || // 〇
    cp === 0x3031 || // 〱
    cp === 0x3032 || // 〲
    cp === 0x25cb || // ○
    cp === 0x30fc || // ー
    cp === 0x3001 || // 、
    cp === 0x3002 || // 。
    cp === 0x30fb || // ・
    cp === 0x30fd || // ヽ
    cp === 0x30fe || // ヾ
    cp === 0x309d || // ゝ
    cp === 0x309e || // ゞ
    cp === 0x0028 || // (
    cp === 0x0029 || // )
    cp === 0xff08 || // （
    cp === 0xff09 || // ）
    cp === 0x003f || // ?
    cp === 0xff1f || // ？
    cp === 0xff0d || // －
    cp === 0x002d || // -
    cp === 0x0020 || // space
    cp === 0x3000 // ideographic space
  ) {
    return true;
  }

  return false;
}

/**
 * @doc word를 문자 단위 Unicode 규칙으로 검사해 오염 여부를 판정한다.
 * @param {string} word 검사 대상 문자열
 * @returns {boolean}
 */
function hasNonJapaneseNoise(word) {
  if (typeof word !== "string" || word.length === 0) return true;
  for (const char of word) {
    if (!isAllowedJapaneseWordChar(char)) {
      return true;
    }
  }
  return false;
}

/**
 * @doc SOURCE 데이터에서 오염된 word 항목을 추출해 복원 요청 목록을 만든다.
 * @param {Array} data SOURCE 데이터 배열
 * @returns {Array<{key:string, id:number, yomiKey:string, readingIndex:number, exampleIndex:number, kanji:string, kana:string, current_word:string, meaning_ko:string, meaning_en:string}>}
 */
function buildCorruptedWordTasks(data) {
  const tasks = [];

  for (const entry of data) {
    for (const yomiKey of ["onyomi", "kunyomi"]) {
      const readings = entry[yomiKey]?.readings ?? [];
      for (let readingIndex = 0; readingIndex < readings.length; readingIndex++) {
        const reading = readings[readingIndex];
        const examples = reading.examples ?? [];
        for (let exampleIndex = 0; exampleIndex < examples.length; exampleIndex++) {
          const example = examples[exampleIndex];
          const currentWord = example.word ?? "";
          if (!hasNonJapaneseNoise(currentWord)) continue;

          tasks.push({
            key: `${entry.id}:${yomiKey}:${readingIndex}:${exampleIndex}`,
            id: entry.id,
            yomiKey,
            readingIndex,
            exampleIndex,
            kanji: entry.kanji ?? "",
            kana: reading.kana ?? "",
            current_word: currentWord,
            meaning_ko: example.meaning?.ko ?? "",
            meaning_en: example.meaning?.en ?? "",
          });
        }
      }
    }
  }

  return tasks;
}

/**
 * @doc 배열을 고정 크기 청크로 분할한다.
 * @param {Array} list 대상 배열
 * @param {number} size 청크 크기
 * @returns {Array<Array>}
 */
function chunkArray(list, size) {
  const chunks = [];
  for (let i = 0; i < list.length; i += size) {
    chunks.push(list.slice(i, i + size));
  }
  return chunks;
}

/**
 * @doc 오염 word 복원 배치를 OpenAI로 요청한다.
 * @param {OpenAI} client OpenAI 클라이언트
 * @param {Array<{key:string, id:number, yomiKey:string, readingIndex:number, exampleIndex:number, kanji:string, kana:string, current_word:string, meaning_ko:string, meaning_en:string}>} tasks 복원 요청 목록
 * @param {string} model 호출 모델명
 * @returns {Promise<Array<{key:string, corrected_word:string}>>}
 */
async function callOpenAIWordFixes(client, tasks, model) {
  const listText = tasks
    .map((t) =>
      [
        `- key: ${t.key}`,
        `  kanji: ${t.kanji}`,
        `  kana: ${t.kana}`,
        `  current_word: ${t.current_word}`,
        `  meaning_ko: ${t.meaning_ko}`,
        `  meaning_en: ${t.meaning_en}`,
      ].join("\n"),
    )
    .join("\n");

  const response = await client.chat.completions.parse({
    model,
    messages: [
      { role: "system", content: FIX_WORD_SYSTEM_PROMPT },
      {
        role: "user",
        content:
          "다음 항목의 오염된 word를 일본어로 복원하세요.\n" +
          "반드시 모든 key를 fixes에 포함하세요.\n\n" +
          listText,
      },
    ],
    response_format: zodResponseFormat(
      CorruptedWordFixBatchResult,
      "corrupted_word_fix_batch_result",
    ),
  });

  return response.choices[0].message.parsed.fixes;
}

/**
 * @doc LLM 복원 결과를 검증하고 유효하면 반환한다(실패 시 예외 발생).
 * @param {string} correctedWord LLM이 반환한 복원 단어
 * @param {string} originalWord 원본 오염 단어
 * @param {string} key 복원 대상 고유 키
 * @returns {string}
 */
function normalizeCorrectedWord(correctedWord, originalWord, key) {
  const trimmed = (correctedWord ?? "").trim();
  if (!trimmed) {
    throw new Error(
      `word 복원 실패: 빈 corrected_word가 반환되었습니다. key=${key}, original="${originalWord}"`,
    );
  }
  if (hasNonJapaneseNoise(trimmed)) {
    throw new Error(
      `word 복원 실패: corrected_word에 비일본어 문자가 포함되어 있습니다. key=${key}, corrected="${trimmed}"`,
    );
  }
  return trimmed;
}

/**
 * @doc SOURCE 데이터의 오염 word를 복원해 메모리상 data를 갱신한다.
 * @param {Array} data SOURCE 데이터 배열
 * @param {Map<string, string>} fixMap key -> corrected_word 맵
 * @returns {{updated:number}}
 */
function applyWordFixesToSourceData(data, fixMap) {
  let updated = 0;

  for (const entry of data) {
    for (const yomiKey of ["onyomi", "kunyomi"]) {
      const readings = entry[yomiKey]?.readings ?? [];
      for (let readingIndex = 0; readingIndex < readings.length; readingIndex++) {
        const reading = readings[readingIndex];
        const examples = reading.examples ?? [];
        for (let exampleIndex = 0; exampleIndex < examples.length; exampleIndex++) {
          const example = examples[exampleIndex];
          const originalWord = example.word ?? "";
          if (!hasNonJapaneseNoise(originalWord)) continue;

          const key = `${entry.id}:${yomiKey}:${readingIndex}:${exampleIndex}`;
          const fixedWord = fixMap.get(key);
          if (!fixedWord) {
            throw new Error(
              `word 복원 실패: key에 해당하는 corrected_word가 없습니다. key=${key}, original="${originalWord}"`,
            );
          }

          const normalized = normalizeCorrectedWord(fixedWord, originalWord, key);
          if (normalized !== originalWord) {
            example.word = normalized;
            updated += 1;
          }
        }
      }
    }
  }

  return { updated };
}

/**
 * @doc 오염 word를 배치 복원하고 SOURCE 파일을 업데이트한다.
 * @param {OpenAI} client OpenAI 클라이언트
 * @param {Object|Array} rawSource SOURCE 원본 파싱 결과(raw)
 * @param {Array} data SOURCE 데이터 배열
 * @param {string} sourceFilePath SOURCE 파일 경로
 * @param {string} model 호출 모델명
 * @returns {Promise<{detected:number, updated:number}>}
 */
async function repairCorruptedWordsInSource(
  client,
  rawSource,
  data,
  sourceFilePath,
  model,
) {
  const tasks = buildCorruptedWordTasks(data);
  if (tasks.length === 0) {
    return { detected: 0, updated: 0 };
  }

  console.log(`\n오염 word 탐지: ${tasks.length}개`);

  const chunks = chunkArray(tasks, 25);
  const fixMap = new Map();

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    console.log(`[word 복원 ${i + 1}/${chunks.length}] ${chunk.length}개 처리 중...`);
    const fixes = await callOpenAIWordFixes(client, chunk, model);
    for (const fix of fixes) {
      fixMap.set(fix.key, fix.corrected_word);
    }
  }

  const { updated } = applyWordFixesToSourceData(data, fixMap);
  if (updated > 0) {
    const serializedSource =
      rawSource && typeof rawSource === "object" && !Array.isArray(rawSource)
        ? { ...rawSource, data }
        : data;
    await fs.writeFile(
      sourceFilePath,
      JSON.stringify(serializedSource, null, 2),
      "utf-8",
    );
  }

  return { detected: tasks.length, updated };
}

// ─── 6. 검증 & 재시도 ───

/**
 * @doc 1차 결과를 검증하고 누락 단어를 재시도로 보강한다.
 * @param {OpenAI} client OpenAI 클라이언트
 * @param {Array<{id:number, word:string, meaning_ko:string}>} requestedWords 원요청 단어 목록
 * @param {{examples:Array<{word:string, example_sentence:string, example_meaning_ko:string, example_meaning_en:string}>}} result 1차 응답
 * @param {string} model 호출 모델명
 * @param {number} [maxRetries=2] 최대 재시도 횟수
 * @returns {Promise<Array<{word:string, example_sentence:string, example_meaning_ko:string, example_meaning_en:string}>>}
 */
async function validateAndRetry(
  client,
  requestedWords,
  result,
  model,
  maxRetries = 2,
) {
  // 1차 응답을 초기값으로 두고 누락분만 보강한다.
  const allExamples = [...result.examples];
  const retrySequence = createRetrySequence(maxRetries);
  await consumeRetrySequence(
    retrySequence,
    requestedWords,
    allExamples,
    client,
    model,
    maxRetries,
  );

  const coveredWords = new Set(allExamples.map((ex) => ex.word));
  const stillMissing = requestedWords.filter((w) => !coveredWords.has(w.word));
  if (stillMissing.length > 0) {
    console.log(
      `    ⚠ 최종 누락 단어: [${stillMissing.map((w) => w.word).join(", ")}]`,
    );
  }

  return allExamples;
}

// ─── 7. 출력 JSON 구성 (입력 구조 미러링) ───

/**
 * @doc 입력 스키마를 유지한 채 생성 예문을 삽입한 출력 JSON을 만든다.
 * @param {Array} originalData 원본 엔트리 배열
 * @param {Array<{word:string, example_sentence:string, example_meaning_ko:string, example_meaning_en:string}>} generatedExamples 생성 예문 목록
 * @param {string} version 출력 버전
 * @returns {{version:string, data:Array}}
 */
function buildOutputJSON(originalData, generatedExamples, version) {
  const wordLookup = buildWordLookup(generatedExamples);

  const outputData = originalData.map((entry) => {
    return buildOutputEntry(entry, wordLookup);
  });

  return { version, data: outputData };
}

/**
 * @doc 생성 결과를 word -> sentences[] 조회 맵으로 변환한다.
 * @param {Array<{word:string, example_sentence:string, example_meaning_ko:string, example_meaning_en:string}>} generatedExamples 생성 예문 목록
 * @returns {Record<string, Array<{sentence:string, meaning:{ko:string, en:string}}>>}
 */
function buildWordLookup(generatedExamples) {
  const wordLookup = {};
  for (const ex of generatedExamples) {
    const w = ex.word;
    if (!wordLookup[w]) wordLookup[w] = [];
    // 동일 단어에 1~2문장 이상이 붙을 수 있으므로 배열로 유지한다.
    wordLookup[w].push({
      sentence: ex.example_sentence,
      meaning: {
        ko: ex.example_meaning_ko,
        en: ex.example_meaning_en,
      },
    });
  }
  return wordLookup;
}

/**
 * @doc 단일 엔트리를 출력 스키마에 맞게 구성한다.
 * @param {Object} entry 원본 엔트리
 * @param {Record<string, Array<{sentence:string, meaning:{ko:string, en:string}}>>} wordLookup word 조회 맵
 * @returns {Object}
 */
function buildOutputEntry(entry, wordLookup) {
  const outEntry = { id: entry.id, kanji: entry.kanji };

  if (entry.onyomi?.readings?.length) {
    outEntry.onyomi = {
      readings: entry.onyomi.readings.map((reading) => ({
        kana: reading.kana,
        examples: (reading.examples ?? []).map((ex) => ({
          word: ex.word,
          meaning: ex.meaning ?? {},
          sentences: wordLookup[ex.word] ?? [],
        })),
      })),
    };
  }

  if (entry.kunyomi?.readings?.length) {
    outEntry.kunyomi = {
      readings: entry.kunyomi.readings.map((reading) => ({
        kana: reading.kana,
        examples: (reading.examples ?? []).map((ex) => ({
          word: ex.word,
          meaning: ex.meaning ?? {},
          sentences: wordLookup[ex.word] ?? [],
        })),
      })),
    };
  }

  return outEntry;
}

/**
 * @doc 기존 출력 JSON에서 id별로 "이미 문장이 있는 단어" 집합을 만든다.
 * @param {Array} outputData 기존 출력 data 배열
 * @returns {Map<number, Set<string>>}
 */
function collectCoveredWordsById(outputData) {
  const coveredById = new Map();
  for (const entry of outputData ?? []) {
    const covered = new Set();
    // "이미 생성 완료"의 기준은 문장 배열이 1개 이상 존재하는지로 본다.
    // meaning만 있고 sentences가 비어있으면 미완료로 간주해야 재시도 대상에 포함된다.
    for (const yomiKey of ["onyomi", "kunyomi"]) {
      for (const reading of entry[yomiKey]?.readings ?? []) {
        for (const wordItem of reading.examples ?? []) {
          if ((wordItem.sentences ?? []).length > 0) {
            covered.add(wordItem.word);
          }
        }
      }
    }
    coveredById.set(entry.id, covered);
  }
  return coveredById;
}

/**
 * @doc 누락 단어가 하나라도 있는 배치를 재시도 대상으로 선별한다.
 * @param {Array<{ids:number[], words:Array<{id:number, word:string, meaning_ko:string}>}>} batches 전체 배치 목록
 * @param {Array<{id:number, words:Array<{id:number, word:string, meaning_ko:string}>}>} wordsById id별 단어 목록
 * @param {Map<number, Set<string>>} coveredById id별 완료 단어 집합
 * @returns {Array<{ids:number[], words:Array}>}
 */
function getFailedBatches(batches, wordsById, coveredById) {
  const wordsByIdMap = new Map(
    wordsById.map((entry) => [entry.id, entry.words]),
  );
  const failed = [];

  // 배치 단위로 실패를 판정한다.
  // 이유: API 호출도 배치 단위이고, 출력 patch도 batch.ids 단위로 재구성하기 때문.
  for (const batch of batches) {
    let isFailed = false;
    for (const id of batch.ids) {
      const requestedWords = wordsByIdMap.get(id) ?? [];
      const coveredWords = coveredById.get(id) ?? new Set();
      // 배치 내부 id 중 하나라도 누락 단어가 있으면 배치 전체를 재시도 대상으로 올린다.
      const hasMissing = requestedWords.some((w) => !coveredWords.has(w.word));
      if (hasMissing) {
        isFailed = true;
        break;
      }
    }
    if (isFailed) {
      failed.push(batch);
    }
  }

  return failed;
}

/**
 * @doc 재생성한 id만 교체(upsert)해 부분 덮어쓰기 결과를 만든다.
 * @param {Array} existingData 기존 output data
 * @param {Array} patchedEntries 재생성된 엔트리들
 * @returns {Array}
 */
function mergePatchedEntries(existingData, patchedEntries) {
  // id 단위 upsert: 재생성된 id만 교체하고 나머지 id는 그대로 보존한다.
  const entryMap = new Map(
    (existingData ?? []).map((entry) => [entry.id, entry]),
  );
  for (const entry of patchedEntries) {
    entryMap.set(entry.id, entry);
  }
  // 입력 순서를 유지하기 위해 id 기준 정렬로 안정화한다.
  return [...entryMap.values()].sort((a, b) => a.id - b.id);
}

// ─── 8. 메인 실행 ───

/**
 * @doc 기존 결과를 재활용해 실패 배치만 재시도하고 output 파일에 부분 반영한다.
 * @returns {Promise<void>}
 */
async function main() {
  const SOURCE_FILE = path.join(
    __dirname,
    "../ref",
    "kanji_merge_grade_meta_reading_scraped_llm.json",
  );
  const OUTPUT_FILE = path.join(__dirname, "../ref", "kanji_examples_llm.json");
  const MIN_WORDS_PER_BATCH = 15;
  const MAX_RETRIES = 2;
  const MODEL = "gpt-4.1-mini"; // 또는 "gpt-4o"
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY 환경변수가 설정되어 있지 않습니다.");
  }

  // 기준 데이터 로드 (재시도 대상 계산의 source of truth)
  const raw = JSON.parse(await fs.readFile(SOURCE_FILE, "utf-8"));
  const version = raw.version ?? "0.0.0";
  const data = raw.data ?? raw;
  const client = new OpenAI({ apiKey: OPENAI_API_KEY });

  // SOURCE 내 오염 word를 먼저 복원해 기준 데이터 자체를 정정한다.
  const repairResult = await repairCorruptedWordsInSource(
    client,
    raw,
    data,
    SOURCE_FILE,
    MODEL,
  );
  if (repairResult.detected > 0) {
    console.log(
      `word 복원 결과: 탐지 ${repairResult.detected}개 / 수정 ${repairResult.updated}개`,
    );
  }

  // 배치 구성
  const wordsById = groupWordsForBatching(data);
  const batches = createBatches(wordsById, MIN_WORDS_PER_BATCH);
  const dataById = new Map(data.map((entry) => [entry.id, entry]));

  console.log(`총 id 수: ${wordsById.length}`);
  console.log(`배치 수: ${batches.length}`);
  for (let i = 0; i < batches.length; i++) {
    const b = batches[i];
    console.log(`  배치 ${i + 1}: ids=[${b.ids}], words=${b.words.length}개`);
  }

  // 기존 결과가 있으면 로드하고 실패 배치만 재시도
  let outputJSON = null;
  try {
    const existingRaw = await fs.readFile(OUTPUT_FILE, "utf-8");
    outputJSON = JSON.parse(existingRaw);
    console.log(`\n기존 결과 로드 완료: ${OUTPUT_FILE}`);
  } catch {
    console.log(`\n기존 결과 없음. 전체 배치를 새로 생성합니다.`);
    outputJSON = { version, data: [] };
  }

  const coveredById = collectCoveredWordsById(outputJSON.data);
  const failedBatches = getFailedBatches(batches, wordsById, coveredById);
  // 기존 결과가 있으면 실패 배치만 재시도하고, 없으면 전체를 생성한다.
  const targetBatches =
    outputJSON.data.length > 0 && failedBatches.length > 0
      ? failedBatches
      : batches;

  if (outputJSON.data.length > 0) {
    console.log(`검증 실패 배치 수: ${failedBatches.length}`);
  }

  if (outputJSON.data.length > 0 && failedBatches.length === 0) {
    console.log("모든 배치가 이미 조건을 만족합니다. 재생성 없이 종료합니다.");
    return;
  }

  // 실패 배치(또는 전체 배치) 재생성
  console.log(`\n${"=".repeat(50)}`);
  console.log("예문 생성/재시도 시작");
  console.log(`${"=".repeat(50)}`);

  const batchSequence = createBatchSequence(targetBatches);
  await consumeBatchSequence(batchSequence, async ({ index, batch }) => {
    console.log(
      `\n[배치 ${index + 1}/${targetBatches.length}] ${batch.words.length}개 단어 처리 중...`,
    );

    try {
      const result = await callOpenAI(client, batch.words, MODEL);
      console.log(`  ✓ 1차 응답: ${result.examples.length}개 예문`);

      const merged = await validateAndRetry(
        client,
        batch.words,
        result,
        MODEL,
        MAX_RETRIES,
      );
      console.log(`  ✓ 최종: ${merged.length}개 예문 확정`);

      // 현재 배치에 포함된 id만 재구성해서 부분 반영한다.
      const targetEntries = batch.ids
        .map((id) => dataById.get(id))
        .filter(Boolean);
      // merged는 현재 배치의 단어 집합만 포함하므로
      // targetEntries 범위에만 적용해야 기존 다른 id 데이터를 훼손하지 않는다.
      const patchedData = buildOutputJSON(targetEntries, merged, version).data;
      outputJSON.data = mergePatchedEntries(outputJSON.data, patchedData);
      // 배치마다 즉시 flush해서 중간 실패가 나도 앞선 성공분은 유지한다.
      await fs.writeFile(
        OUTPUT_FILE,
        JSON.stringify(outputJSON, null, 2),
        "utf-8",
      );
      console.log(`  ✓ 배치 결과 저장 완료 (ids=[${batch.ids.join(", ")}])`);
    } catch (err) {
      console.error(`  ✗ 에러: ${err.message}`);
    }
  });

  // 버전 동기화 및 최종 저장
  // 중간 저장 후에도 최종 버전을 원본 입력과 맞춰 일관성을 보장한다.
  outputJSON.version = version;
  await fs.writeFile(OUTPUT_FILE, JSON.stringify(outputJSON, null, 2), "utf-8");

  let totalExamples = 0;
  for (const entry of outputJSON.data) {
    for (const yomiKey of ["onyomi", "kunyomi"]) {
      for (const reading of entry[yomiKey]?.readings ?? []) {
        for (const wordItem of reading.examples ?? []) {
          totalExamples += wordItem.sentences?.length ?? 0;
        }
      }
    }
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`생성 예문 수: ${totalExamples}`);
  console.log(`결과 저장: ${OUTPUT_FILE}`);
}

main();
