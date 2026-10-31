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

/// 앱 시작(`setup`)에서 한 번: 계정 토큰 저장소의 암호화(Kotlin `SecretBox`, Android Keystore AES-GCM)를 `gc_hosting`에 등록한다.
/// 앱 클래스는 네이티브 스레드에서 못 찾으므로 Activity의 클래스 로더로 지금 읽어 전역 참조로 쥔다. 실패하면 암호화 없이는 토큰을 저장하지 않는다(`Keychain`이 오류).
pub fn init_secret_cipher() -> Result<(), String> {
    let ctx = ndk_context::android_context();
    // SAFETY: init_tls_verifier와 같다.
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) };
    let class = vm
        .attach_current_thread(|env| -> Result<jni::objects::Global<jni::objects::JClass<'static>>, jni::errors::Error> {
            let activity = unsafe { jni::objects::JObject::from_raw(env, ctx.context().cast()) };
            let loader = env.call_method(&activity, jni::jni_str!("getClassLoader"), jni::jni_sig!(() -> JClassLoader), &[])?.l()?;
            let loader = env.cast_local::<jni::objects::JClassLoader>(loader)?;
            let name = env.new_string("com.goldtagworks.git403.SecretBox")?;
            let class = env.call_method(&loader, jni::jni_str!("loadClass"), jni::jni_sig!((JString) -> JClass), &[jni::objects::JValue::from(&name)])?.l()?;
            let class = env.cast_local::<jni::objects::JClass>(class)?;
            env.new_global_ref(class)
        })
        .map_err(|e| e.to_string())?;
    gc_hosting::set_secret_cipher(std::sync::Arc::new(Keystore { vm, class }));
    Ok(())
}

/// Kotlin `SecretBox.seal/open(byte[]) -> byte[]` 호출.
struct Keystore {
    vm: jni::JavaVM,
    class: jni::objects::Global<jni::objects::JClass<'static>>,
}

impl Keystore {
    fn call(&self, method: &'static jni::strings::JNIStr, input: &[u8]) -> gc_hosting::Result<Vec<u8>> {
        self.vm
            .attach_current_thread(|env| -> Result<Vec<u8>, jni::errors::Error> {
                let arr = env.byte_array_from_slice(input)?;
                let out = env.call_static_method(&self.class, method, jni::jni_sig!((byte[]) -> byte[]), &[jni::objects::JValue::from(&arr)])?.l()?;
                let out = env.cast_local::<jni::objects::JByteArray>(out)?;
                env.convert_byte_array(&out)
            })
            .map_err(|e| gc_hosting::Error::Store(format!("Keystore: {e}")))
    }
}

impl gc_hosting::SecretCipher for Keystore {
    fn seal(&self, plain: &[u8]) -> gc_hosting::Result<Vec<u8>> {
        self.call(jni::jni_str!("seal"), plain)
    }
    fn open(&self, sealed: &[u8]) -> gc_hosting::Result<Vec<u8>> {
        self.call(jni::jni_str!("open"), sealed)
    }
}
