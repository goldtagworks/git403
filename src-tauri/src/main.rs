// 릴리스 빌드에서 Windows 콘솔 창을 숨긴다.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // git·ssh가 인증 입력을 위해 이 실행 파일을 askpass로 부른 경우
    if git403_lib::askpass_helper() {
        return;
    }
    git403_lib::run()
}
