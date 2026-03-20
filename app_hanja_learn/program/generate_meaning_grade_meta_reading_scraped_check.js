/**
 * 한자 onyomi/kunyomi examples 점검 및 예문 생성기 (OpenAI Structured Output)
 *
 * - kanji_merge_grade_meta_reading_scraped_llm.json 를 읽어
 * - 각 항목의 onyomi/kunyomi readings examples를 LLM으로 점검
 *   (잘못된 word 수정/삭제, 중복 제거, 빈 항목 처리, 필요 시 생성)
 * - 점검 완료된 word마다 예문(sentences) 추가
 * - 결과를 kanji_merge_grade_meta_reading_scraped_llm_check.json 으로 저장
 *
 * 실행: OPENAI_API_KEY=sk-... node generate_meaning_grade_meta_reading_scraped_check.js
 */
require("dotenv").config();
const fs = require("fs/promises");
const path = require("path");
const OpenAI = require("openai");
const { z } = require("zod");
const { zodResponseFormat } = require("openai/helpers/zod");

// ─── 설정 ───

const SOURCE_FILE = path.join(
  __dirname,
  "../ref",
  "kanji_merge_grade_meta_reading_scraped_llm.json",
);
const OUTPUT_FILE = path.join(
  __dirname,
  "../ref",
  "kanji_merge_grade_meta_reading_scraped_llm_check.json",
);
const FAILED_FILE = path.join(
  __dirname,
  "../ref",
  "kanji_check_failed_batches.json",
);
const MIN_WORDS_PER_BATCH = 15;
const MAX_RETRIES = 2;
const MODEL = "gpt-5-mini";

// ─── Zod 스키마 ───

const SentenceSchema = z.object({
  sentence: z.string().describe("일본어 예문"),
  meaning: z.object({
    ko: z.string().describe("한국어 번역"),
    en: z.string().describe("영어 번역"),
  }),
});

const ExampleSchema = z.object({
  word: z.string().describe("일본어 단어 (한자/가나)"),
  meaning: z.object({
    ko: z.string().describe("한국어 뜻"),
    en: z.string().describe("영어 뜻"),
  }),
  sentences: z.array(SentenceSchema).describe("예문 1~2개"),
});

const ReadingSchema = z.object({
  kana: z.string().describe("가나 읽기"),
  examples: z.array(ExampleSchema),
});

const ItemResultSchema = z.object({
  id: z.number().describe("원본 항목 id"),
  kanji: z.string().describe("한자"),
  onyomi_readings: z.array(ReadingSchema),
  kunyomi_readings: z.array(ReadingSchema),
});

const BatchResultSchema = z.object({
  items: z.array(ItemResultSchema),
});

// ─── 시스템 프롬프트 ───

const SYSTEM_PROMPT = `당신은 일본어 한자 교육 데이터 전문가입니다.
주어진 한자 항목들의 onyomi/kunyomi readings의 examples를 점검하고 예문을 추가해주세요.

## 1단계: examples 점검 (word 검증)
각 reading의 examples에 있는 word들을 점검하세요:

### 삭제 대상:
- 일본어가 아닌 글자가 포함된 word
- 실제 일본어 단어/표현이 아닌 것
- 의미 없거나 이상한 word
- 중복된 word (같은 reading 내에서 동일 의미 word가 여러 번)
- word가 비어있는 항목

### 수정 대상:
- word에 일본어가 아닌 글자가 일부 섞여있지만 의도를 파악할 수 있는 경우 → 올바른 일본어 단어로 수정
- 약간의 오타가 있는 경우 → 수정

### 중요 규칙:
- 삭제 후 해당 reading의 examples가 0개가 되면, 해당 한자(kanji)와 kana에 맞는 적절한 단어를 1개 이상 생성하세요.
- word는 반드시 해당 kanji 문자를 포함하고, 해당 kana 읽기와 연관된 것이어야 합니다.
- meaning의 ko(한국어)와 en(영어)이 비어있으면 채워주세요. 기존 값이 있으면 유지하세요.

## 2단계: 예문 생성
점검 완료된 각 word에 대해 예문을 생성하세요:

### 예문 규칙:
- 각 단어당 최소 1개, 최대 2개의 예문
- 일상 대화에서 쓸만한 예문이 우선순위가 높음
- 어려운 단어라면 뉴스 본문에 쓸만한 예문도 무관
- 단어 난이도에 맞게 자연스럽게 작성
- 각 예문에는 한국어 번역(ko)과 영어 번역(en) 포함
- 모든 word에 대해 빠짐없이 예문 생성. 누락 불가

## 출력 형식:
- 입력된 모든 항목(id)을 빠짐없이 출력
- 각 항목의 onyomi_readings, kunyomi_readings 구조를 유지
- examples 내 각 word 항목에 sentences 배열 추가`;

// ─── 데이터 추출 ───

/**
 * LLM에 보낼 경량 데이터 추출 (id, kanji, readings만)
 */
function extractForLLM(item) {
  return {
    id: item.id,
    kanji: item.kanji,
    onyomi_readings: (item.onyomi?.readings || []).map((r) => ({
      kana: r.kana,
      examples: (r.examples || []).map((ex) => ({
        word: ex.word || "",
        meaning: {
          ko: ex.meaning?.ko || "",
          en: ex.meaning?.en || "",
        },
      })),
    })),
    kunyomi_readings: (item.kunyomi?.readings || []).map((r) => ({
      kana: r.kana,
      examples: (r.examples || []).map((ex) => ({
        word: ex.word || "",
        meaning: {
          ko: ex.meaning?.ko || "",
          en: ex.meaning?.en || "",
        },
      })),
    })),
  };
}

/**
 * 항목의 총 word 수 계산
 */
function countWords(item) {
  let count = 0;
  for (const r of item.onyomi?.readings || []) {
    count += (r.examples || []).length;
  }
  for (const r of item.kunyomi?.readings || []) {
    count += (r.examples || []).length;
  }
  return Math.max(count, 1); // 최소 1 (빈 항목도 LLM이 생성해야 하므로)
}

// ─── 배치 구성 ───

/**
 * 항목들을 최소 word 수 기준으로 배치화
 */
function createBatches(data, minWords) {
  const batches = [];
  let currentIndices = [];
  let currentWordCount = 0;

  for (let i = 0; i < data.length; i++) {
    const wc = countWords(data[i]);
    currentIndices.push(i);
    currentWordCount += wc;

    if (currentWordCount >= minWords) {
      batches.push({
        indices: [...currentIndices],
        wordCount: currentWordCount,
      });
      currentIndices = [];
      currentWordCount = 0;
    }
  }

  if (currentIndices.length > 0) {
    if (batches.length > 0 && currentWordCount < minWords) {
      const last = batches[batches.length - 1];
      last.indices.push(...currentIndices);
      last.wordCount += currentWordCount;
    } else {
      batches.push({ indices: currentIndices, wordCount: currentWordCount });
    }
  }

  return batches;
}

// ─── 제너레이터 ───

function* createBatchSequence(batches) {
  for (let i = 0; i < batches.length; i++) {
    yield { index: i, batch: batches[i] };
  }
}

function* createRetrySequence(maxRetries) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    yield attempt;
  }
}

// ─── 제너레이터 소비 (재귀) ───

async function consumeBatchSequence(batchSequence, handler) {
  const { value, done } = batchSequence.next();
  if (done) return;
  await handler(value);
  return consumeBatchSequence(batchSequence, handler);
}

async function consumeRetrySequence(
  retrySequence,
  data,
  batchIndices,
  resultMap,
  client,
  totalRetries,
) {
  const { value: attempt, done } = retrySequence.next();
  if (done) return resultMap;

  // 누락된 id 찾기
  const missingIndices = batchIndices.filter(
    (idx) => !resultMap.has(data[idx].id),
  );
  if (missingIndices.length === 0) return resultMap;

  const missingItems = missingIndices.map((idx) => extractForLLM(data[idx]));
  console.log(
    `    ⚠ 누락 ${missingIndices.length}개 항목 → 재시도 ${attempt}/${totalRetries}`,
  );

  try {
    const retryResult = await callOpenAI(client, missingItems);
    for (const item of retryResult.items) {
      resultMap.set(item.id, item);
    }
  } catch (err) {
    console.error(`    ✗ 재시도 실패: ${err.message}`);
  }

  return consumeRetrySequence(
    retrySequence,
    data,
    batchIndices,
    resultMap,
    client,
    totalRetries,
  );
}

// ─── OpenAI 호출 ───

async function callOpenAI(client, itemsForLLM) {
  const response = await client.chat.completions.parse({
    model: MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: JSON.stringify(itemsForLLM),
      },
    ],
    response_format: zodResponseFormat(BatchResultSchema, "batch_result"),
  });

  return response.choices[0].message.parsed;
}

// ─── 결과 병합 ───

/**
 * LLM 결과를 원본 항목에 병합
 */
function mergeResult(originalItem, llmItem) {
  if (!llmItem) return originalItem;

  const merged = { ...originalItem };

  // onyomi 병합
  if (originalItem.onyomi) {
    merged.onyomi = {
      ...originalItem.onyomi,
      readings: mergeReadings(
        originalItem.onyomi.readings || [],
        llmItem.onyomi_readings || [],
      ),
    };
  }

  // kunyomi 병합
  if (originalItem.kunyomi) {
    merged.kunyomi = {
      ...originalItem.kunyomi,
      readings: mergeReadings(
        originalItem.kunyomi.readings || [],
        llmItem.kunyomi_readings || [],
      ),
    };
  }

  return merged;
}

/**
 * readings 배열 병합: LLM 결과의 examples(점검/예문 포함)로 교체하되
 * 원본의 romaji, isPrimary 등 메타데이터는 유지
 */
function mergeReadings(originalReadings, llmReadings) {
  const llmMap = new Map();
  for (const lr of llmReadings) {
    llmMap.set(lr.kana, lr);
  }

  return originalReadings.map((origReading) => {
    const llmReading = llmMap.get(origReading.kana);
    if (!llmReading) return origReading;

    return {
      ...origReading,
      examples: llmReading.examples.map((llmEx) => ({
        word: llmEx.word,
        meaning: {
          ko: llmEx.meaning?.ko || "",
          en: llmEx.meaning?.en || "",
        },
        sentences: (llmEx.sentences || []).map((s) => ({
          sentence: s.sentence,
          meaning: {
            ko: s.meaning?.ko || "",
            en: s.meaning?.en || "",
          },
        })),
      })),
    };
  });
}

// ─── 검증 ───

/**
 * 병합된 항목이 올바른지 점검
 * - 모든 reading에 최소 1개 example
 * - 모든 example에 최소 1개 sentence
 * - word가 비어있지 않음
 */
function validateMergedItem(item) {
  const errors = [];

  for (const yomiKey of ["onyomi", "kunyomi"]) {
    const readings = item[yomiKey]?.readings || [];
    for (const reading of readings) {
      if (!reading.examples || reading.examples.length === 0) {
        errors.push(`${yomiKey} kana=${reading.kana}: examples 비어있음`);
        continue;
      }
      for (const ex of reading.examples) {
        if (!ex.word || ex.word.trim() === "") {
          errors.push(`${yomiKey} kana=${reading.kana}: word 비어있음`);
        }
        if (!ex.sentences || ex.sentences.length === 0) {
          errors.push(
            `${yomiKey} kana=${reading.kana} word=${ex.word}: sentences 비어있음`,
          );
        }
      }
    }
  }

  return errors;
}

// ─── 기존 결과 활용 ───

/**
 * 기존 output에서 이미 처리 완료된 id 집합 반환
 */
function collectCompletedIds(outputData) {
  const completedIds = new Set();

  for (const item of outputData) {
    let isComplete = true;

    for (const yomiKey of ["onyomi", "kunyomi"]) {
      const readings = item[yomiKey]?.readings || [];
      for (const reading of readings) {
        for (const ex of reading.examples || []) {
          if (!ex.sentences || ex.sentences.length === 0) {
            isComplete = false;
            break;
          }
        }
        if (!isComplete) break;
      }
      if (!isComplete) break;
    }

    if (isComplete) {
      completedIds.add(item.id);
    }
  }

  return completedIds;
}

// ─── 메인 ───

async function main() {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY 환경변수가 설정되어 있지 않습니다.");
  }

  const client = new OpenAI({ apiKey: OPENAI_API_KEY });

  // 데이터 로드
  console.log("데이터 로드 중...");
  const raw = await fs.readFile(SOURCE_FILE, "utf-8");
  const data = JSON.parse(raw);
  console.log(`총 ${data.length}개 항목`);

  // 기존 결과 로드 (있으면 이어서 처리)
  let outputData = [];
  let completedIds = new Set();
  try {
    const existingRaw = await fs.readFile(OUTPUT_FILE, "utf-8");
    outputData = JSON.parse(existingRaw);
    completedIds = collectCompletedIds(outputData);
    console.log(`기존 결과 로드: ${completedIds.size}개 완료됨`);
  } catch {
    console.log("기존 결과 없음. 전체 처리 시작.");
    outputData = [...data]; // 원본 복사
  }

  // 실패 파일에서 재처리 대상 id 로드
  let failedOnlyIds = null;
  let failedFileExists = false;
  try {
    const failedRaw = await fs.readFile(FAILED_FILE, "utf-8");
    failedFileExists = true;
    const failedReport = JSON.parse(failedRaw);
    if (failedReport.failedIds && failedReport.failedIds.length > 0) {
      failedOnlyIds = new Set(failedReport.failedIds);
      console.log(
        `실패 파일 로드: ${failedOnlyIds.size}개 항목 재처리 대상 (${FAILED_FILE})`,
      );
    }
  } catch {
    // 실패 파일 없음
  }

  // OUTPUT_FILE이 존재하고 FAILED_FILE이 없으면 → 이전 실행이 성공 완료된 것
  if (completedIds.size > 0 && !failedFileExists) {
    console.log(
      "이전 실행이 성공적으로 완료됨 (실패 파일 없음). 재처리 없이 종료합니다.",
    );
    console.log(
      "전체 재실행이 필요하면 OUTPUT_FILE을 삭제하세요.",
    );
    return;
  }

  // 처리할 인덱스 필터링
  const pendingIndices = [];
  for (let i = 0; i < data.length; i++) {
    if (failedOnlyIds) {
      // 실패 파일에 id가 있으면 해당 id만 재처리
      if (failedOnlyIds.has(data[i].id)) {
        pendingIndices.push(i);
      }
    } else {
      // 없으면 미완료 항목 처리
      if (!completedIds.has(data[i].id)) {
        pendingIndices.push(i);
      }
    }
  }

  if (pendingIndices.length === 0) {
    console.log("모든 항목이 이미 처리 완료. 종료합니다.");
    return;
  }

  console.log(`처리 대기: ${pendingIndices.length}개 항목`);

  // 배치 구성 (pendingIndices 기준)
  const batches = [];
  let currentIndices = [];
  let currentWordCount = 0;

  for (const idx of pendingIndices) {
    const wc = countWords(data[idx]);
    currentIndices.push(idx);
    currentWordCount += wc;

    if (currentWordCount >= MIN_WORDS_PER_BATCH) {
      batches.push({
        indices: [...currentIndices],
        wordCount: currentWordCount,
      });
      currentIndices = [];
      currentWordCount = 0;
    }
  }

  if (currentIndices.length > 0) {
    if (batches.length > 0 && currentWordCount < MIN_WORDS_PER_BATCH) {
      const last = batches[batches.length - 1];
      last.indices.push(...currentIndices);
      last.wordCount += currentWordCount;
    } else {
      batches.push({ indices: currentIndices, wordCount: currentWordCount });
    }
  }

  console.log(`배치 수: ${batches.length}`);

  // outputData를 id로 인덱싱
  const outputMap = new Map(outputData.map((item) => [item.id, item]));

  // 실패 배치 추적
  const failedBatches = [];

  // 배치 순차 처리 (generator)
  const batchSequence = createBatchSequence(batches);
  await consumeBatchSequence(batchSequence, async ({ index, batch }) => {
    const batchItems = batch.indices.map((idx) => data[idx]);
    const batchItemsForLLM = batchItems.map(extractForLLM);

    console.log(
      `\n[${index + 1}/${batches.length}] ${batchItems.length}개 항목, ${batch.wordCount}개 word 처리 중...`,
    );

    try {
      // 1차 호출
      const result = await callOpenAI(client, batchItemsForLLM);
      console.log(`  ✓ 1차 응답: ${result.items.length}개 항목`);

      // 결과를 id 맵으로
      const resultMap = new Map();
      for (const item of result.items) {
        resultMap.set(item.id, item);
      }

      // 누락 시 재시도
      const retrySequence = createRetrySequence(MAX_RETRIES);
      await consumeRetrySequence(
        retrySequence,
        data,
        batch.indices,
        resultMap,
        client,
        MAX_RETRIES,
      );

      // 병합 및 검증
      let failedCount = 0;
      const failedIds = [];
      for (const idx of batch.indices) {
        const original = data[idx];
        const llmItem = resultMap.get(original.id);
        const merged = mergeResult(original, llmItem);

        const errors = validateMergedItem(merged);
        if (errors.length > 0) {
          failedCount++;
          failedIds.push({ id: original.id, kanji: original.kanji, errors });
          console.log(
            `    ⚠ id=${original.id} (${original.kanji}) 검증 실패: ${errors[0]}${errors.length > 1 ? ` 외 ${errors.length - 1}건` : ""}`,
          );
        }

        outputMap.set(original.id, merged);
      }

      // 검증 실패 항목 재시도
      if (failedCount > 0) {
        console.log(`  → 검증 실패 ${failedCount}개 항목 재처리 중...`);
        const failedIndices = batch.indices.filter((idx) => {
          const item = outputMap.get(data[idx].id);
          return validateMergedItem(item).length > 0;
        });

        if (failedIndices.length > 0) {
          const failedItemsForLLM = failedIndices.map((idx) =>
            extractForLLM(data[idx]),
          );
          try {
            const retryResult = await callOpenAI(client, failedItemsForLLM);
            for (const llmItem of retryResult.items) {
              const original = data.find((d) => d.id === llmItem.id);
              if (original) {
                const reMerged = mergeResult(original, llmItem);
                outputMap.set(original.id, reMerged);
              }
            }
            console.log(`  ✓ 재처리 완료`);
          } catch (retryErr) {
            console.error(`  ✗ 재처리 실패: ${retryErr.message}`);
          }
        }

        // 재처리 후에도 여전히 실패한 항목 기록
        const stillFailedIds = batch.indices
          .filter((idx) => {
            const item = outputMap.get(data[idx].id);
            return validateMergedItem(item).length > 0;
          })
          .map((idx) => ({
            id: data[idx].id,
            kanji: data[idx].kanji,
            errors: validateMergedItem(outputMap.get(data[idx].id)),
          }));

        if (stillFailedIds.length > 0) {
          failedBatches.push({
            batchIndex: index,
            ids: stillFailedIds.map((f) => f.id),
            details: stillFailedIds,
          });
        }
      }

      console.log(`  ✓ 배치 ${index + 1} 완료`);

      // 배치마다 즉시 저장
      const sortedOutput = [...outputMap.values()].sort((a, b) => a.id - b.id);
      await fs.writeFile(
        OUTPUT_FILE,
        JSON.stringify(sortedOutput, null, 2),
        "utf-8",
      );
    } catch (err) {
      // 배치 전체가 실패한 경우 (API 오류 등)
      const batchIds = batch.indices.map((idx) => ({
        id: data[idx].id,
        kanji: data[idx].kanji,
      }));
      failedBatches.push({
        batchIndex: index,
        ids: batchIds.map((b) => b.id),
        error: err.message,
        details: batchIds,
      });
      console.error(`  ✗ 배치 ${index + 1} 실패: ${err.message}`);
    }
  });

  // 실패 배치 파일 저장
  if (failedBatches.length > 0) {
    const allFailedIds = failedBatches.flatMap((b) => b.ids);
    const failedReport = {
      createdAt: new Date().toISOString(),
      totalFailed: allFailedIds.length,
      failedIds: allFailedIds,
      batches: failedBatches,
    };
    await fs.writeFile(
      FAILED_FILE,
      JSON.stringify(failedReport, null, 2),
      "utf-8",
    );
    console.log(`\n⚠ 실패 ${allFailedIds.length}개 항목 → ${FAILED_FILE}`);
  } else {
    // 이전 실패 파일이 있으면 삭제
    try {
      await fs.unlink(FAILED_FILE);
    } catch {
      // 파일이 없으면 무시
    }
  }

  console.log(`\n처리 완료! 결과: ${OUTPUT_FILE}`);
}

main().catch((err) => {
  console.error("치명적 오류:", err);
  process.exit(1);
});
