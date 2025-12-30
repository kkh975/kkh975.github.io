/**
 * 일본어 한자 스크래핑 스크립트
 *
 * nihongokanji.com 사이트에서 한자 학습 자료를 순차적으로 수집하여 JSON으로 저장합니다.
 *
 * 플로우:
 * 1. 메인 페이지에서 "N* 한자 일람 + 바로가기 링크" 레벨별 링크 찾기
 * 2. 각 레벨 페이지에서 "숫자. (한자)" 형식의 한자 링크 찾기
 * 3. 각 한자 페이지에서 "tt_article_useless_p_margin contents_style" 요소 추출
 * 4. data/scraped_kanji_data.json에 저장
 *
 * 주의: 순차 실행, 각 페이지 방문 후 1초 대기
 */

const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");

// 저장 경로
const outputPath = path.join(__dirname, "../ref", "scraped_kanji.json");

// 유틸리티 함수
// 지정된 시간(밀리초)만큼 대기하는 비동기 함수
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 배열을 async generator로 변환 (index 포함)
// 배열의 각 요소를 순회하면서 인덱스와 함께 yield하는 제너레이터 함수
async function* arrayToGenerator(array) {
  for (let index = 0; index < array.length; index++) {
    yield { item: array[index], index };
  }
}

// 브라우저 생성 및 설정
// Puppeteer를 사용하여 헤드리스 브라우저를 생성하고 페이지를 설정
async function createBrowser() {
  const browser = await puppeteer.launch({
    headless: "new", // 새로운 헤드리스 모드 사용
    args: ["--ignore-certificate-errors"], // SSL 인증서 오류 무시
  });

  const page = await browser.newPage();
  await page.setRequestInterception(true); // 요청 가로채기 활성화
  page.on("request", (req) => {
    req.continue(); // 모든 요청을 계속 진행
  });

  return { browser, page };
}

// 메인 페이지에서 레벨별 링크 찾기
// "한자 일람"과 "바로가기 링크" 텍스트를 포함하는 링크들을 찾아 반환
async function findLevelLinks(page) {
  await page.goto("https://nihongokanji.com/notice/2284", {
    waitUntil: "networkidle2", // 네트워크가 500ms 동안 유휴 상태일 때까지 대기
    timeout: 60000, // 60초 타임아웃
  });
  await sleep(1000); // 페이지 로딩 대기

  const levelLinks = await page.evaluate(() => {
    const links = [];
    const anchors = document.querySelectorAll(
      ".tt_article_useless_p_margin.contents_style a"
    );
    anchors.forEach((anchor) => {
      const text = anchor.textContent.trim();
      // "한자 일람"과 "바로가기 링크"를 모두 포함하는 링크만 선택
      if (text.includes("한자 일람") && text.includes("바로가기 링크")) {
        links.push({
          text: text,
          url: anchor.href,
        });
      }
    });
    return links;
  });

  return levelLinks;
}

// 레벨 페이지에서 한자 링크 찾기
// 레벨 페이지의 모든 링크를 찾아 URL 배열로 반환
async function findKanjiLinks(page) {
  const kanjiLinks = await page.evaluate(() => {
    const anchors = document.querySelectorAll(
      ".tt_article_useless_p_margin.contents_style a"
    );

    return Array.from(anchors).map((anchor) => anchor.href);
  });

  return kanjiLinks;
}

// 한자 페이지 방문 (DOM 파싱은 하지 않음)
async function scrapeKanjiContent(page, url) {
  await page.goto(url, {
    waitUntil: "networkidle2",
    timeout: 60000,
  });
  await sleep(1000);
  // DOM 파싱은 하지 않고 페이지 방문만 수행
}

// 데이터 파싱 함수 (puppeteer를 사용하여 DOM 파싱)
async function parseData(page, content) {
  const parsed = await page.evaluate(() => {
    const root = document.querySelector(
      ".tt_article_useless_p_margin.contents_style"
    );
    if (!root) return null;

    const sections = Array.from(root.querySelectorAll("h3"));

    // 한자 추출 함수: #head h2 a에서 "23.「生」" 형식에서 한자만 추출
    const extractKanji = () => {
      const headLink = document.querySelector("#head h2 a");
      if (!headLink) return "";
      const titleText = headLink.textContent.trim();
      // 「」 안의 한자 추출
      // 정규식: [「]([^」]+)[」] - 「로 시작하고 」로 끝나는 부분에서 」를 제외한 모든 문자 추출
      const match = titleText.match(/[「]([^」]+)[」]/);
      return match ? match[1] : "";
    };

    // ruby 태그를 제거하고 순수 텍스트만 추출하는 함수
    // ruby 태그는 일본어 한자의 읽기 표시를 위한 HTML 태그
    const getTextWithoutRuby = (el) => {
      if (!el) return "";
      const clone = el.cloneNode(true);
      // 모든 ruby 태그를 그 안의 텍스트로 대체
      clone.querySelectorAll("ruby").forEach((ruby) => {
        ruby.replaceWith(ruby.textContent);
      });
      return clone.textContent.trim();
    };

    // li 요소에서 reading(읽기)과 words(단어 목록)를 추출하는 함수 (DOM 기반 파서)
    // 패턴: <b><span style="background-color: #dddddd;">reading</span></b> word1 meaning1, word2 meaning2, ...
    // 반환: { reading: string, words: Array<{word: string, meaning: string}> }
    //
    // 처리 과정:
    // 1. 회색 배경(#dddddd)을 가진 span에서 reading 추출
    // 2. reading 영역 제거
    // 3. 남은 콘텐츠를 쉼표로 분리하여 각 세그먼트에서 word-meaning 쌍 추출
    const extractWordsFromLi = (li) => {
      const result = { reading: "", words: [] };
      const clone = li.cloneNode(true);

      // 1. reading 추출: background-color: #dddddd 스타일을 가진 span 찾기
      const readingSpan = clone.querySelector(
        'span[style*="background-color: #dddddd"], span[style*="background-color:#dddddd"]'
      );

      if (!readingSpan) return result;

      // reading 텍스트 추출
      result.reading = readingSpan.textContent.trim();

      // 2. reading 영역 제거 (b 태그와 함께)
      // readingSpan의 부모가 b태그면 b태그 전체를, 아니면 readingSpan만 제거
      let elementToRemove = readingSpan;
      if (
        readingSpan.parentElement &&
        readingSpan.parentElement.tagName === "B"
      ) {
        elementToRemove = readingSpan.parentElement;
      } else if (readingSpan.querySelector("b")) {
        // span 안에 b가 있는 경우 (예: <span><b>reading</b></span>)
        elementToRemove = readingSpan;
      }
      elementToRemove.remove();

      // 3. 남은 콘텐츠에서 쉼표로 분리하여 word-meaning 쌍 추출
      // clone의 모든 내용을 하나의 컨테이너로 처리
      const contentContainer = clone;

      // 노드들을 순회하면서 쉼표를 기준으로 세그먼트 분리
      const segments = [];
      let currentSegment = document.createElement("span");

      const splitByComma = (node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          let text = node.textContent || "";
          let lastIndex = 0;

          // 모든 쉼표 위치 찾기
          // 정규식: [,，] - 영어 쉼표(,) 또는 일본어 쉼표(，) 매칭, g 플래그로 전역 검색
          const commaRegex = /[,，]/g;
          let match;

          while ((match = commaRegex.exec(text)) !== null) {
            const beforeComma = text.slice(lastIndex, match.index);
            if (beforeComma) {
              currentSegment.appendChild(document.createTextNode(beforeComma));
            }

            // 현재 세그먼트 완료
            if (
              currentSegment.childNodes.length > 0 ||
              currentSegment.innerHTML
            ) {
              segments.push(currentSegment);
            }
            currentSegment = document.createElement("span");
            lastIndex = match.index + 1;
          }

          // 마지막 쉼표 이후 텍스트
          const remaining = text.slice(lastIndex);
          if (remaining) {
            currentSegment.appendChild(document.createTextNode(remaining));
          }
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.tagName === "RUBY") {
            // ruby 태그는 그대로 유지
            currentSegment.appendChild(node.cloneNode(true));
          } else {
            // 다른 요소는 자식 노드들을 재귀 처리
            Array.from(node.childNodes).forEach(splitByComma);
          }
        }
      };

      Array.from(contentContainer.childNodes).forEach(splitByComma);

      // 마지막 세그먼트 추가
      if (currentSegment.childNodes.length > 0) {
        segments.push(currentSegment);
      }

      // 4. 각 세그먼트에서 word와 meaning 분리 (한글 또는 숫자 시작 지점 기준)
      segments.forEach((segment) => {
        let wordParts = [];
        let meaningParts = [];
        let foundMeaning = false;

        const processNode = (node) => {
          if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent || "";

            if (!foundMeaning) {
              // 한글 또는 숫자가 시작되는 위치 찾기
              // 정규식: [가-힣0-9] - 한글 문자(가부터 힣까지) 또는 숫자(0-9) 매칭
              const meaningStartPos = text.search(/[가-힣0-9]/);
              if (meaningStartPos === -1) {
                // 한글/숫자 없음 - word에 추가
                wordParts.push(text);
              } else {
                // 한글 또는 숫자 발견 - meaning 시작
                foundMeaning = true;
                const beforeMeaning = text.slice(0, meaningStartPos);
                const afterMeaning = text.slice(meaningStartPos);
                if (beforeMeaning) {
                  wordParts.push(beforeMeaning);
                }
                if (afterMeaning) {
                  meaningParts.push(afterMeaning);
                }
              }
            } else {
              // 이미 meaning 영역 - meaning에 추가
              meaningParts.push(text);
            }
          } else if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.tagName === "RUBY") {
              if (!foundMeaning) {
                // ruby는 word에 추가
                wordParts.push(node.outerHTML);
              } else {
                // meaning 영역의 ruby는 텍스트만 추출하여 meaning에 추가
                meaningParts.push(getTextWithoutRuby(node));
              }
            } else {
              // 다른 요소는 자식 노드 재귀 처리
              Array.from(node.childNodes).forEach(processNode);
            }
          }
        };

        Array.from(segment.childNodes).forEach(processNode);

        // word와 meaning 조합
        const wordHTML = wordParts
          .join("")
          .replace(/&nbsp;/g, " ") // &nbsp;를 일반 공백으로 변환
          .replace(/\s+/g, " ") // 연속된 공백을 하나의 공백으로 변환
          .trim();
        let meaningText = meaningParts
          .join("")
          .replace(/&nbsp;/g, " ") // &nbsp;를 일반 공백으로 변환
          .replace(/\s+/g, " ") // 연속된 공백을 하나의 공백으로 변환
          .trim();

        if (wordHTML) {
          result.words.push({
            word: wordHTML,
            meaning: meaningText,
          });
        }
      });

      return result;
    };

    // 이미지 요소에서 URL을 추출하는 함수
    const getImageUrl = (img) => {
      if (!img) return "";
      return img.src || "";
    };

    // "기본 정보" 섹션을 파싱하는 함수
    // 의미(meaning), 음독(onyomi), 훈독(kunyomi) 정보를 추출
    const parseBasicInfo = () => {
      const result = { meaning: [], onyomi: [], kunyomi: [] };
      const section = sections.find((h3) =>
        h3.textContent.includes("기본 정보")
      );
      if (!section) return result;

      let next = section.nextElementSibling;
      while (next && next.tagName !== "H3") {
        if (next.tagName === "UL") {
          next.querySelectorAll("li").forEach((li) => {
            const text = getTextWithoutRuby(li);
            if (text.includes("의미")) {
              // DOM 기반으로 의미 추출
              const clone = li.cloneNode(true);

              // "의미" 레이블 span 제거
              const meaningLabel = clone.querySelector(
                'span[style*="background-color: #dddddd"], span[style*="background-color:#dddddd"]'
              );
              if (meaningLabel) {
                meaningLabel.remove();
              }

              // 남은 콘텐츠에서 의미들 추출
              const meanings = [];

              // <b> 태그로 감싸진 텍스트들을 추출
              const bTags = clone.querySelectorAll("b");
              if (bTags.length > 0) {
                bTags.forEach((b) => {
                  let bText = b.textContent.trim();
                  // "의미" 텍스트와 주변 공백 제거
                  // 정규식: 의미\s* - "의미" 뒤에 0개 이상의 공백 문자 매칭
                  bText = bText.replace(/의미\s*/, "").trim();
                  if (bText) {
                    // 앞뒤 따옴표 제거 (여러 개일 수 있음)
                    // 정규식: ^[""]+|[""]+$ - 문자열 시작(^) 또는 끝($)에 있는 따옴표(" 또는 ")를 모두 제거
                    let cleanText = bText.replace(/^[""]+|[""]+$/g, "");
                    // 마침표, 쉼표로 분리
                    // 정규식: [.,、] - 마침표(.), 쉼표(,) 또는 일본어 쉼표(、)로 분리
                    const parts = cleanText
                      .split(/[.,、]/)
                      .map((s) => {
                        // 각 부분에서도 앞뒤 따옴표 제거
                        return s.trim().replace(/^[""]+|[""]+$/g, "");
                      })
                      .filter(Boolean);
                    meanings.push(...parts);
                  }
                });
              } else {
                // <b> 태그가 없으면 일반 텍스트에서 추출
                let cleanedText = clone.textContent || "";
                // "의미" 텍스트 제거
                // 정규식: 의미\s* - "의미" 뒤에 0개 이상의 공백 문자 매칭
                cleanedText = cleanedText.replace(/의미\s*/, "").trim();
                // 앞뒤 따옴표 제거
                // 정규식: ^[""]+|[""]+$ - 문자열 시작(^) 또는 끝($)에 있는 따옴표(" 또는 ")를 모두 제거
                cleanedText = cleanedText.replace(/^[""]+|[""]+$/g, "");
                const parts = cleanedText
                  .split(/[.,、]/) // 정규식: [.,、] - 마침표(.), 쉼표(,) 또는 일본어 쉼표(、)로 분리
                  .map((s) => {
                    // 각 부분에서도 앞뒤 따옴표 제거
                    return s.trim().replace(/^[""]+|[""]+$/g, "");
                  })
                  .filter(Boolean);
                meanings.push(...parts);
              }

              result.meaning = meanings;
            } else if (text.includes("음독")) {
              // 정규식: 음독\s+(.+) - "음독" 뒤에 1개 이상의 공백(\s+)과 그 이후의 모든 문자(.+) 매칭
              const match = text.match(/음독\s+(.+)/);
              if (match) {
                result.onyomi = match[1]
                  .split(/[、,]/) // 정규식: [、,] - 일본어 쉼표(、) 또는 영어 쉼표(,)로 분리
                  .map((s) => s.trim())
                  .filter(Boolean);
              }
            } else if (text.includes("훈독")) {
              // 정규식: 훈독\s+(.+) - "훈독" 뒤에 1개 이상의 공백(\s+)과 그 이후의 모든 문자(.+) 매칭
              const match = text.match(/훈독\s+(.+)/);
              if (match) {
                result.kunyomi = match[1]
                  .split(/[、,]/) // 정규식: [、,] - 일본어 쉼표(、) 또는 영어 쉼표(,)로 분리
                  .map((s) => s.trim())
                  .filter(Boolean);
              }
            }
          });
        }
        next = next.nextElementSibling;
      }
      return result;
    };

    // "한자 모양 해설" 섹션을 파싱하는 함수
    // 한자의 모양을 설명하는 이미지와 텍스트를 추출
    const parseShapeDescription = () => {
      const section = sections.find((h3) =>
        h3.textContent.includes("한자 모양 해설")
      );
      const result = { image: "", text: "" };
      if (!section) return result;

      let next = section.nextElementSibling;
      while (next && !next.matches("h3")) {
        if (next.matches("figure.imageblock")) {
          const img = next.querySelector("img");
          if (img) result.image = getImageUrl(img);
        } else if (next.matches("p") && next.textContent.trim()) {
          result.text += (result.text ? " " : "") + getTextWithoutRuby(next);
        }
        next = next.nextElementSibling;
      }
      return result;
    };

    // "음독 상세" 또는 "훈독 상세" 섹션을 파싱하는 함수
    // 설명(description), 대표단어(representativeWords), 예문(examples)을 추출
    const parseReadingDetail = (label) => {
      const section = sections.find((h3) => h3.textContent.includes(label));
      const result = { description: "", representativeWords: [], examples: [] };
      if (!section) return result;

      // label에서 "음독" 또는 "훈독" 추출
      // 음독: 한자의 중국식 읽기, 훈독: 한자의 일본식 읽기
      const readingType = label.includes("음독") ? "음독" : "훈독";

      let next = section.nextElementSibling;
      while (next && !next.matches("h3")) {
        if (next.matches("p") && next.textContent.trim()) {
          const text = getTextWithoutRuby(next);
          // "대표단어"나 "예문"이 포함되지 않은 경우에만 description에 추가
          if (text && !text.includes("대표단어") && !text.includes("예문")) {
            result.description += (result.description ? " " : "") + text;
          }
        } else if (next.matches("h4")) {
          const h4Text = next.textContent;
          const hasRepresentativeWords = h4Text.includes("대표단어");
          const hasExamples = h4Text.includes("예문");
          const hasReadingType = h4Text.includes(readingType);

          // 해당 읽기 타입(음독/훈독)과 관련된 h4인지 확인
          if (hasReadingType && (hasRepresentativeWords || hasExamples)) {
            const list = next.nextElementSibling;
            if (list && list.tagName === "UL") {
              list.querySelectorAll("li").forEach((li) => {
                // li 요소에서 reading과 words를 추출
                const extracted = extractWordsFromLi(li);

                // reading이 없으면 건너뛰기
                if (!extracted.reading) return;

                const item = {
                  reading: extracted.reading,
                  words: extracted.words,
                };

                // "대표단어"가 포함되어 있으면 representativeWords에 추가
                if (hasRepresentativeWords) {
                  result.representativeWords.push(item);
                }
                // "예문"이 포함되어 있으면 examples에 추가
                if (hasExamples) {
                  result.examples.push(item);
                }
              });
            }
          }
        }
        next = next.nextElementSibling;
      }
      return result;
    };

    return {
      kanji: extractKanji(),
      kanjiImage: root.querySelector("figure.imageblock img")?.src || "",
      basicInfo: parseBasicInfo(),
      shapeDescription: parseShapeDescription(),
      onyomiDetail: parseReadingDetail("음독 상세"),
      kunyomiDetail: parseReadingDetail("훈독 상세"),
    };
  });

  if (!parsed) return null;

  return {
    kanji: parsed.kanji || "",
    // 레벨 파싱: "N5", "N 5" 같은 형식에서 숫자만 추출하여 숫자 타입으로 저장
    // 정규식: ([0-9]) - 첫 번째 숫자만 추출
    level: content.level
      ? parseInt(content.level.match(/([0-9])/)?.[1] || "0", 10) || null
      : null,
    url: content.url || "",
    image: parsed.kanjiImage || "",
    basicInfo: {
      meaning: parsed.basicInfo?.meaning || [],
      onyomi: parsed.basicInfo?.onyomi || [],
      kunyomi: parsed.basicInfo?.kunyomi || [],
    },
    shapeDescription: {
      image: parsed.shapeDescription?.image || "",
      text: parsed.shapeDescription?.text || "",
    },
    onyomiDetail: {
      description: parsed.onyomiDetail?.description || "",
      representativeWords: parsed.onyomiDetail?.representativeWords || [],
      examples: parsed.onyomiDetail?.examples || [],
    },
    kunyomiDetail: {
      description: parsed.kunyomiDetail?.description || "",
      representativeWords: parsed.kunyomiDetail?.representativeWords || [],
      examples: parsed.kunyomiDetail?.examples || [],
    },
  };
}

// 데이터를 JSON 파일로 저장 (하나씩 추가)
async function saveData(dataItem) {
  // 기존 데이터 읽기
  let existingData = [];
  try {
    const fileContent = await fs.promises.readFile(outputPath, "utf8");
    existingData = JSON.parse(fileContent);
  } catch (error) {
    // 파일이 없거나 손상되었거나 빈 파일인 경우 빈 배열로 시작
    existingData = [];
  }

  // 새 데이터 추가
  existingData.push(dataItem);

  // 파일에 저장
  await fs.promises.writeFile(
    outputPath,
    JSON.stringify(existingData, null, 2),
    "utf8"
  );
  console.log(`데이터 저장 완료 (총 ${existingData.length}개)`);
}

// 메인 스크래핑 함수
async function scrapeKanji() {
  // 기존 출력 파일이 존재하면 삭제
  try {
    await fs.promises.access(outputPath);
    await fs.promises.unlink(outputPath);
    console.log("기존 파일 삭제 완료");
  } catch (error) {
    // 파일이 존재하지 않으면 무시
    if (error.code !== "ENOENT") {
      console.error("파일 삭제 중 오류:", error);
    }
  }

  const { browser, page } = await createBrowser();

  try {
    console.log("메인 페이지 방문 중...");
    const levelLinks = (await findLevelLinks(page)).slice(0);
    console.log(`${levelLinks.length}개 레벨 페이지 찾음`);

    for await (const { item: levelLink, index } of arrayToGenerator(
      levelLinks
    )) {
      console.log(
        `\n[${index + 1}/${levelLinks.length}] ${levelLink.text} 방문 중...`
      );

      await page.goto(levelLink.url, {
        waitUntil: "networkidle2",
        timeout: 60000,
      });
      const kanjiLinks = (await findKanjiLinks(page)).slice(0);

      for await (const {
        item: kanjiLink,
        index: kanjiIndex,
      } of arrayToGenerator(kanjiLinks)) {
        console.log(
          `  [${kanjiIndex + 1}/${
            kanjiLinks.length
          }] ${kanjiLink} 스크래핑 중...`
        );

        await sleep(1000); // await 누락 수정: 각 페이지 방문 후 1초 대기
        await scrapeKanjiContent(page, kanjiLink); // 방문만 수행
        const parsedContent = await parseData(page, {
          level: levelLink.text,
          url: kanjiLink,
        });
        await saveData(parsedContent);
      }
    }
  } catch (error) {
    console.error("에러 발생:", error);
  } finally {
    await browser.close();
  }
}

// 스크립트 실행
scrapeKanji();
