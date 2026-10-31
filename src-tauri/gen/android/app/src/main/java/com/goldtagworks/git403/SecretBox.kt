package com.goldtagworks.git403

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * 계정 토큰 파일(secrets.enc)을 암호화하는 Android Keystore AES-256-GCM 상자.
 * 키는 Keystore 안에서만 존재하고(앱 전용·추출 불가) 이 코드는 키를 보지 못한다. Rust(`src-tauri/src/android.rs`)가 JNI로 부른다.
 * 봉인 형식 = iv(12바이트) + 암호문+태그. 실패는 예외(Rust 쪽이 오류로 바꾼다).
 */
object SecretBox {
    private const val ALIAS = "git403.secrets.v1"
    private const val PROVIDER = "AndroidKeyStore"
    private const val AAD = "git403-secrets-v1"
    private const val IV_LEN = 12

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance(PROVIDER).apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER)
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build()
        )
        return gen.generateKey()
    }

    @JvmStatic
    fun seal(plain: ByteArray): ByteArray {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, key())
        c.updateAAD(AAD.toByteArray())
        return c.iv + c.doFinal(plain)
    }

    @JvmStatic
    fun open(sealed: ByteArray): ByteArray {
        require(sealed.size > IV_LEN) { "sealed data too short" }
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, sealed.copyOfRange(0, IV_LEN)))
        c.updateAAD(AAD.toByteArray())
        return c.doFinal(sealed, IV_LEN, sealed.size - IV_LEN)
    }
}
