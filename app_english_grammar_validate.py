
import json

def process_json(json_file):
    # JSON 파일을 로드합니다.
    with open(json_file, 'r', encoding='utf-8') as file:
        data = json.load(file)

    # categories의 각 요소를 반복 처리합니다.
    for idx, category in enumerate(data['categories']):
        category['id'] = str(idx + 1)  # ID 업데이트
        # category 내의 data 요소 처리
        for item_idx, item in enumerate(category['data']):
            item['id'] = str(item_idx + 1)  # data 내의 ID 업데이트
            
            # 필수 필드 확인
            if 'quiz' not in item or 'options' not in item or 'correct' not in item:
                raise ValueError('quiz, options, or correct key is missing in one of the data items')

            # quiz 값에 특정 문자열이 포함되어 있는지 확인
            if '<!-(problem area)-!>' not in item['quiz']:
                raise ValueError('quiz does not contain the required placeholder "<!-(problem area)-!>"')
            
            # qusion과 quizType 필드 추가
            item['quesion'] = "다음 빈칸에 알맞는 답을 고르세요."
            item['quizType'] = "type1"

    # 파일에 수정된 데이터를 다시 작성합니다.
    with open(json_file, 'w', encoding='utf-8') as file:
        json.dump(data, file, indent=2, ensure_ascii=False)

# 예제 JSON 파일 경로 지정
json_file_path = 'app_english_grammar.json'
process_json(json_file_path)
