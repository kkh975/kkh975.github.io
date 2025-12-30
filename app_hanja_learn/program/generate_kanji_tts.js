const fs = require("fs");
const path = require("path");
const https = require("https");
const textToSpeech = require("@google-cloud/text-to-speech");

/**
 * Resemble AI 또는 Google Chirp 3 Text-to-Speech를 사용하여 한자 읽기(kana) 음성 파일 생성
 *
 * 사용 전 설정:
 *
 * Resemble AI 사용 시:
 * 1. Resemble AI 계정 생성 및 API 키 발급
 * 2. 환경 변수 설정:
 *    export RESEMBLE_API_KEY="your_api_key_here"
 *    export RESEMBLE_VOICE_FEMALE="your-female-voice-uuid"
 *    export RESEMBLE_VOICE_MALE="your-male-voice-uuid"
 *
 * Google Chirp 3 사용 시:
 * 1. Google Cloud 프로젝트 설정 및 인증
 * 2. Text-to-Speech API 활성화
 * 3. 서비스 계정 키 파일 생성 후 환경 변수 설정:
 *    export GOOGLE_APPLICATION_CREDENTIALS="path/to/service-account-key.json"
 *
 * 사용할 TTS 서비스 선택:
 *    export TTS_PROVIDER="resemble" 또는 "google"
 */

// 파일 경로 설정
const jsonFilePath = path.join(
  __dirname,
  "../ref",
  "kanji_merge_grade_meta_reading_scraped_llm.json"
);
const audioDir = path.join(__dirname, "../data/kanji_voice");

// 파일명에서 특수문자 제거/변환 함수
const sanitizeFileName = (str) => {
  return str
    .replace(/[\/\\?%*:|"<>]/g, "_") // 파일명에 사용할 수 없는 문자를 언더스코어로 변환
    .replace(/\s+/g, "_"); // 공백을 언더스코어로 변환
};

// kana에서 특수문자 제거 함수 (TTS용)
const cleanKanaText = (str) => {
  return str.trim().replace(/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?~`\s]/g, ""); // 특수문자와 공백 제거
};

// TTS 제공자 설정
const TTS_PROVIDER = process.env.TTS_PROVIDER || "google"; // "resemble" 또는 "google"

// Resemble AI API 키 및 음성 UUID 설정
const RESEMBLE_API_KEY = process.env.RESEMBLE_API_KEY || "";
const RESEMBLE_API_URL = "https://f.cluster.resemble.ai/synthesize";

// Google TTS 클라이언트 초기화
let googleClient = null;
if (TTS_PROVIDER === "google") {
  try {
    googleClient = new textToSpeech.TextToSpeechClient();
  } catch (error) {
    console.warn("Google TTS 클라이언트 초기화 실패:", error.message);
  }
}

// Resemble AI TTS로 음성 파일 생성 함수
const generateAudioWithResemble = async (text, outputPath, voiceUuid) => {
  return new Promise((resolve, reject) => {
    if (!RESEMBLE_API_KEY) {
      console.error("RESEMBLE_API_KEY 환경 변수가 설정되지 않았습니다.");
      reject(new Error("API key not set"));
      return;
    }

    const requestData = JSON.stringify({
      voice_uuid: voiceUuid,
      data: text,
      output_format: "mp3",
      sample_rate: 48000,
    });

    const url = new URL(RESEMBLE_API_URL);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: "POST",
      headers: {
        Authorization: RESEMBLE_API_KEY,
        "Content-Type": "application/json",
        "Accept-Encoding": "gzip",
        "Content-Length": Buffer.byteLength(requestData),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        try {
          const response = JSON.parse(data);

          if (response.success && response.audio_content) {
            // Base64 디코드하여 오디오 파일 저장
            const audioBuffer = Buffer.from(response.audio_content, "base64");
            fs.writeFileSync(outputPath, audioBuffer);
            resolve(true);
          } else {
            console.error(
              `TTS 생성 실패: ${response.issues || "Unknown error"}`
            );
            reject(new Error(response.issues || "Synthesis failed"));
          }
        } catch (error) {
          console.error(`응답 파싱 오류: ${error.message}`);
          reject(error);
        }
      });
    });

    req.on("error", (error) => {
      console.error(`TTS 생성 오류 (${text}):`, error.message);
      reject(error);
    });

    req.write(requestData);
    req.end();
  });
};

// Google Chirp 3 TTS로 음성 파일 생성 함수
const generateAudioWithGoogle = async (text, outputPath, voiceName, gender) => {
  try {
    if (!googleClient) {
      throw new Error("Google TTS 클라이언트가 초기화되지 않았습니다.");
    }

    const request = {
      input: { text: text },
      voice: {
        languageCode: "ja-JP",
        name: voiceName,
        ssmlGender: gender,
      },
      audioConfig: {
        audioEncoding: "MP3",
      },
    };

    const [response] = await googleClient.synthesizeSpeech(request);

    // 오디오 파일 저장
    fs.writeFileSync(outputPath, response.audioContent, "binary");
    return true;
  } catch (error) {
    console.error(`TTS 생성 오류 (${text}, ${gender}):`, error.message);
    throw error;
  }
};

// 1초 대기 함수 (API rate limit 방지)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 개별 reading 처리 함수
const processReading = async (item, reading, type, stats) => {
  if (!reading.kana || reading.kana.trim() === "") {
    return;
  }

  const kana = reading.kana.trim();
  const cleanedKana = cleanKanaText(kana);

  // kana가 비어있으면 건너뛰기
  if (!cleanedKana) {
    return;
  }

  const fileNameKana = sanitizeFileName(kana);

  // TTS 제공자에 따라 음성 설정
  let voices = [];

  if (TTS_PROVIDER === "resemble") {
    // Resemble AI 음성 설정
    voices = [
      {
        uuid: "55592656",
        suffix: "female",
      },
    ];
  } else if (TTS_PROVIDER === "google") {
    // Google Chirp 3 음성 설정
    voices = [
      {
        name: "ja-JP-Chirp-3-A", // 여성 음성
        gender: "FEMALE",
        suffix: "female",
      },
      {
        name: "ja-JP-Chirp-3-B", // 남성 음성
        gender: "MALE",
        suffix: "male",
      },
    ];
  } else {
    console.error(`지원하지 않는 TTS 제공자: ${TTS_PROVIDER}`);
    return;
  }

  // 각 음성에 대해 파일 생성
  for (const voice of voices) {
    const fileName = `${item.id}_${item.kanji}_${type}_${fileNameKana}_${voice.suffix}.mp3`;
    const filePath = path.join(audioDir, fileName);

    // 이미 파일이 존재하면 건너뛰기
    if (fs.existsSync(filePath)) {
      console.log(`이미 존재: ${fileName}`);
      stats.skipCount++;
      continue;
    }

    try {
      console.log(
        `생성 중: ${fileName} (${cleanedKana}, ${voice.suffix}, ${TTS_PROVIDER})`
      );

      if (TTS_PROVIDER === "resemble") {
        if (!voice.uuid) {
          console.log(
            `건너뜀: ${voice.suffix} voice_uuid가 설정되지 않았습니다.`
          );
          continue;
        }
        await generateAudioWithResemble(cleanedKana, filePath, voice.uuid);
      } else if (TTS_PROVIDER === "google") {
        await generateAudioWithGoogle(
          cleanedKana,
          filePath,
          voice.name,
          voice.gender
        );
      }

      console.log(`완료: ${fileName}`);
      stats.successCount++;

      // API rate limit 방지를 위해 1초 대기
      await sleep(1000);
    } catch (error) {
      console.error(`실패: ${fileName} - ${error.message}`);
      stats.failCount++;
      await sleep(1000);
    }
  }
};

// 메인 함수
const main = async () => {
  try {
    // 오디오 디렉토리가 없으면 생성
    if (!fs.existsSync(audioDir)) {
      fs.mkdirSync(audioDir, { recursive: true });
    }

    console.log("JSON 파일 읽는 중...");
    const jsonData = JSON.parse(fs.readFileSync(jsonFilePath, "utf8"));
    console.log(`총 ${jsonData.length}개의 항목을 찾았습니다.`);

    const stats = {
      successCount: 0,
      failCount: 0,
      skipCount: 0,
    };

    // // 순차적으로 처리
    for (const item of jsonData.slice(0, 2)) {
      // Onyomi readings 처리
      if (
        item.onyomi &&
        item.onyomi.readings &&
        item.onyomi.readings.length > 0
      ) {
        for (const reading of item.onyomi.readings.slice(0, 2)) {
          await processReading(item, reading, "onyomi", stats);
        }
      }

      // Kunyomi readings 처리
      if (
        item.kunyomi &&
        item.kunyomi.readings &&
        item.kunyomi.readings.length > 0
      ) {
        for (const reading of item.kunyomi.readings.slice(0, 2)) {
          await processReading(item, reading, "kunyomi", stats);
        }
      }
    }

    console.log("\n=== TTS 생성 완료 ===");
    console.log(`성공: ${stats.successCount}개`);
    console.log(`실패: ${stats.failCount}개`);
    console.log(`건너뜀: ${stats.skipCount}개`);
  } catch (error) {
    console.error("오류 발생:", error);
    process.exit(1);
  }
};

main();
