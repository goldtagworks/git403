package com.goldtagworks.git403

import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // 시스템 막대(상태 표시줄·내비게이션 막대·컷아웃·키보드) 뒤로 WebView가 그려지지 않게 그 크기만큼 안쪽 여백을 둔다.
    // WebView의 env(safe-area-inset-*)는 기기·버전마다 0으로 오므로 CSS에 맡기지 않는다. 막대 뒤는 창 배경색(앱 배경과 같은 값)이 보인다.
    ViewCompat.setOnApplyWindowInsetsListener(findViewById(android.R.id.content)) { v, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime())
      v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }
  }
}
