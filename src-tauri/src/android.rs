//! Android 전용: rustls-platform-verifier(reqwest·gix fetch의 TLS 인증서 검증)는 JVM·Context·클래스 로더를 받아야 동작한다.
//! 안 하면 첫 HTTPS 요청에서 패닉한다. 앱 쪽 Kotlin 컴포넌트는 gen/android의 gradle 의존성(`org.rustls:rustls-platform-verifier`)이 넣는다.

/// tao가 `ndk_context`에 넣어 둔 JVM·Activity로 초기화한다 (setup에서 한 번).
/// 전제: `ndk_context::android_context()`는 tao의 Android 진입점이 `run()`을 부르기 전에 이미 설정해 둔다. 그래서 반드시 `run()` 안(`setup`)에서 불러야 한다.
/// 이 호출이 setup보다 먼저 일어나면 ndk-context가 패닉한다.
pub fn init_tls_verifier() {
    let ctx = ndk_context::android_context();
    // SAFETY: tao가 유효한 JavaVM 포인터와 Activity 전역 참조를 넣어 둔다.
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) };
    let res = vm.attach_current_thread(|env| {
        let activity = unsafe { jni::objects::JObject::from_raw(env, ctx.context().cast()) };
        rustls_platform_verifier::android::init_with_env(env, activity)
    });
    // 이 크레이트에는 logcat 로거가 없다. 초기화 실패는 이후 모든 HTTPS가 패닉하므로 원인을 담아 바로 패닉한다.
    if let Err(e) = res {
        panic!("rustls-platform-verifier JNI 초기화 실패 (gradle의 org.rustls:rustls-platform-verifier 누락?): {e}");
    }
}
