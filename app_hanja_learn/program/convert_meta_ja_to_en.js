const fs = require('fs');
const path = require('path');

// 漢検級을 숫자로 변환하는 함수
function convertKankenLevel(kankenLevel) {
  if (!kankenLevel || typeof kankenLevel !== 'string') {
    return null;
  }
  
  // 準2級 > 2
  if (kankenLevel === '準2級') {
    return 2;
  }
  
  // 2級 > 1, 3級 > 3, 4級 > 4, ... 10級 > 10
  const match = kankenLevel.match(/^(\d+)級$/);
  if (match) {
    const level = parseInt(match[1], 10);
    if (level === 2) {
      return 1; // 2級은 1로 변환
    }
    return level; // 나머지는 그대로
  }
  
  return null;
}

// 깨진 문자 확인 함수
function checkCorruptedChars(data, fileName) {
  const corrupted = [];
  const replacementChar = '\uFFFD'; // U+FFFD replacement character
  
  // 재귀적으로 객체의 모든 값을 확인
  function checkValue(obj, path = '') {
    if (Array.isArray(obj)) {
      obj.forEach((item, index) => {
        checkValue(item, `${path}[${index}]`);
      });
    } else if (obj !== null && typeof obj === 'object') {
      Object.keys(obj).forEach(key => {
        const newPath = path ? `${path}.${key}` : key;
        checkValue(obj[key], newPath);
      });
    } else if (typeof obj === 'string') {
      if (obj.includes(replacementChar)) {
        corrupted.push({
          path: path,
          value: obj,
          positions: []
        });
        
        // 각 깨진 문자의 위치 찾기
        for (let i = 0; i < obj.length; i++) {
          if (obj[i] === replacementChar) {
            corrupted[corrupted.length - 1].positions.push(i);
          }
        }
      }
    }
  }
  
  checkValue(data);
  
  return corrupted;
}

// 메인 변환 함수
function convertMetaJaToEn() {
  const jaFilePath = path.join(__dirname, '../ref/kanji_meta_ja.json');
  const enFilePath = path.join(__dirname, '../ref/kanji_meta_en.json');
  
  console.log('Reading kanji_meta_ja.json...');
  const jaData = JSON.parse(fs.readFileSync(jaFilePath, 'utf8'));
  
  console.log(`Converting ${jaData.length} entries...`);
  
  const enData = jaData.map(item => {
    const converted = {
      id: item['識別番号'],
      kanji: item['漢字'],
      kankenLevel: convertKankenLevel(item['漢検級']),
      radicalId: item['部首ID'],
      radicalKanji: item['部首'],
      radicalName: item['部首名']
    };
    
    return converted;
  });
  
  console.log('Writing kanji_meta_en.json...');
  fs.writeFileSync(enFilePath, JSON.stringify(enData, null, 2), 'utf8');
  
  console.log('Checking for corrupted characters...');
  const corrupted = checkCorruptedChars(enData, 'kanji_meta_en.json');
  
  if (corrupted.length === 0) {
    console.log('✓ No corrupted characters found');
  } else {
    console.log(`\n✗ Found ${corrupted.length} corrupted value(s):\n`);
    // 처음 10개만 상세 출력
    const maxDisplay = 10;
    corrupted.slice(0, maxDisplay).forEach((item, index) => {
      console.log(`${index + 1}. Path: ${item.path}`);
      console.log(`   Value: ${JSON.stringify(item.value)}`);
      console.log(`   Positions: ${item.positions.join(', ')}`);
      console.log('');
    });
    if (corrupted.length > maxDisplay) {
      console.log(`... and ${corrupted.length - maxDisplay} more corrupted value(s)\n`);
    }
    console.log('⚠️  Warning: Corrupted characters detected in the output file!');
    process.exit(1);
  }
  
  console.log('\n✓ Conversion completed successfully!');
  console.log(`✓ Total entries: ${enData.length}`);
}

// 실행
try {
  convertMetaJaToEn();
} catch (error) {
  console.error('Error:', error.message);
  process.exit(1);
}

