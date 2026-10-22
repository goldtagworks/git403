//! 패치 파일 형식 판별: `git format-patch` 결과(메일 형식)인지 일반 diff인지.

use std::io::Read;
use std::path::Path;

use crate::Result;

/// 파일 앞부분이 mbox 형식(`From <sha> …` 첫 줄 + `Subject:` 헤더)이면 true.
/// 메일 형식은 `git am`, 일반 diff는 `git apply`로 적용한다.
pub fn is_mailbox_patch(path: &Path) -> Result<bool> {
    let mut head = Vec::new();
    std::fs::File::open(path)?.take(8192).read_to_end(&mut head)?;
    Ok(looks_like_mail(&String::from_utf8_lossy(&head)))
}

fn looks_like_mail(text: &str) -> bool {
    let mut lines = text.lines();
    if !lines.next().is_some_and(|l| l.starts_with("From ")) {
        return false;
    }
    // 헤더(빈 줄 전까지)에 Subject가 있어야 한다.
    lines.take_while(|l| !l.is_empty()).any(|l| l.starts_with("Subject:"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_mail_and_plain_diff() {
        let mail = "From 1234 Mon Sep 17 00:00:00 2001\nFrom: a <a@a>\nSubject: [PATCH] x\n\n---\n";
        assert!(looks_like_mail(mail));
        assert!(!looks_like_mail("diff --git a/a b/a\n--- a/a\n+++ b/a\n"));
        assert!(!looks_like_mail("From the top\nbody\n"));
        assert!(!looks_like_mail(""));
    }
}
