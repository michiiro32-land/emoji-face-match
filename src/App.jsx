import React, { useRef, useEffect, useState, useCallback } from 'react'
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'

// ── 表情定義 ──────────────────────────────────────────────
const EXPRESSIONS = [
  {
    id: 'happy',
    emoji: '😊',
    label: 'ニコッ！',
    color: '#FFD700',
    score: (bs) => avg(bs, ['mouthSmileLeft','mouthSmileRight']),
  },
  {
    id: 'surprised',
    emoji: '😮',
    label: 'びっくり！',
    color: '#FF6B9D',
    // jawOpen（口を大きく開ける）が一番確実。眉も上げると完璧
    score: (bs) => Math.min(1,
      get(bs,'jawOpen') * 1.4 * 0.6 +
      avg(bs,['browInnerUp','browOuterUpLeft','browOuterUpRight']) * 0.4
    ),
  },
  {
    id: 'angry',
    emoji: '😠',
    label: 'むっ！',
    color: '#FF4444',
    score: (bs) => avg(bs, ['browDownLeft','browDownRight','noseSneerLeft','noseSneerRight']),
  },
  {
    id: 'sad',
    emoji: '😢',
    label: 'しょんぼり…',
    color: '#64B5F6',
    score: (bs) => avg(bs, ['mouthFrownLeft','mouthFrownRight','browInnerUp']),
  },
  {
    id: 'wink',
    emoji: '😉',
    label: 'ウィンク！',
    color: '#AB47BC',
    score: (bs) => max(
      get(bs,'eyeBlinkLeft') * 0.9 - get(bs,'eyeBlinkRight') * 0.5,
      get(bs,'eyeBlinkRight') * 0.9 - get(bs,'eyeBlinkLeft') * 0.5,
    ),
  },
]

function get(bs, name) {
  return bs?.find(b => b.categoryName === name)?.score ?? 0
}
function avg(bs, names) {
  return names.reduce((s,n) => s + get(bs,n), 0) / names.length
}
function max(...vals) { return Math.max(...vals) }

const GOAL = 0.60       // この閾値を超えたら達成
const HOLD_MS = 800     // 何ms維持したらカウント
const TOTAL_SEC = 90    // ゲーム時間
const SKIP_SEC = 7      // 何秒以内に一致しなかったらスキップ

// ── メインコンポーネント ─────────────────────────────────
export default function App() {
  const videoRef    = useRef(null)
  const canvasRef   = useRef(null)
  const detRef      = useRef(null)   // FaceLandmarker
  const rafRef      = useRef(null)
  const holdRef     = useRef(null)   // 達成開始時刻

  const [phase, setPhase]     = useState('title')  // title|loading|play|over
  const [status, setStatus]   = useState('')
  const [score, setScore]     = useState(0)
  const [timeLeft, setTimeLeft] = useState(TOTAL_SEC)
  const [exprIdx, setExprIdx] = useState(0)
  const [conf, setConf]       = useState(0)
  const [flash, setFlash]     = useState(false)
  const [skipLeft, setSkipLeft] = useState(SKIP_SEC)
  const [skipped, setSkipped]   = useState(false)
  const [dbgBS, setDbgBS]       = useState([])    // デバッグ用ブレンドシェイプ

  const gRef = useRef({
    running: false, score: 0, exprIdx: 0, conf: 0,
    holdStart: null, lastTime: 0, exprStart: 0,
  })

  // ── モデル読み込み ──
  const loadModel = async () => {
    setStatus('🧠 AIモデル読み込み中...')
    const fileset = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/wasm'
    )
    detRef.current = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
        delegate: 'GPU',
      },
      outputFaceBlendshapes: true,
      runningMode: 'VIDEO',
      numFaces: 1,
    })
  }

  // ── ゲームループ ──
  const loop = useCallback(() => {
    const g = gRef.current
    if (!g.running) return

    const video  = videoRef.current
    const canvas = canvasRef.current
    if (!canvas || !video || video.readyState < 2) {
      rafRef.current = requestAnimationFrame(loop); return
    }
    const ctx = canvas.getContext('2d')
    const W = canvas.width, H = canvas.height

    // カメラ描画（鏡像）
    const vw = video.videoWidth || W, vh = video.videoHeight || H
    const sc = Math.max(W/vw, H/vh)
    const sw = vw*sc, sh = vh*sc
    const ox = (W-sw)/2, oy = (H-sh)/2
    ctx.save(); ctx.scale(-1,1); ctx.drawImage(video, -(ox+sw), oy, sw, sh); ctx.restore()
    ctx.fillStyle='rgba(0,0,0,0.12)'; ctx.fillRect(0,0,W,H)

    // 表情検出
    const now = performance.now()
    if (detRef.current && now - g.lastTime > 100) {
      try {
        const res = detRef.current.detectForVideo(video, now)
        if (res.faceBlendshapes?.length > 0) {
          const bs = res.faceBlendshapes[0].categories
          const expr = EXPRESSIONS[g.exprIdx]
          const c = Math.min(1, expr.score(bs) / GOAL)
          g.conf = c
          setConf(c)
          // デバッグ: 値が高いブレンドシェイプ上位10件
          const top = [...bs]
            .filter(b => b.score > 0.05)
            .sort((a,b) => b.score - a.score)
            .slice(0, 10)
          setDbgBS(top)

          // スキップ判定
          const elapsedSec = (Date.now() - g.exprStart) / 1000
          const remaining = Math.max(0, SKIP_SEC - elapsedSec)
          setSkipLeft(Math.ceil(remaining))
          if (remaining <= 0) {
            // 時間切れ → スキップ（returnしない！ループ継続）
            g.exprIdx = (g.exprIdx + 1) % EXPRESSIONS.length
            setExprIdx(g.exprIdx)
            g.holdStart = null; g.exprStart = Date.now()
            g.conf = 0; setConf(0)
            setSkipped(true); setTimeout(() => setSkipped(false), 800)
          } else if (c >= 1.0) {
            if (!g.holdStart) { g.holdStart = Date.now() }
            else if (Date.now() - g.holdStart > HOLD_MS) {
              // 達成！
              g.score++
              setScore(g.score)
              g.exprIdx = (g.exprIdx + 1) % EXPRESSIONS.length
              setExprIdx(g.exprIdx)
              g.holdStart = null; g.exprStart = Date.now()
              g.conf = 0; setConf(0)
              setFlash(true); setTimeout(() => setFlash(false), 400)
            }
          } else {
            g.holdStart = null
          }
        }
      } catch(_) {}
      g.lastTime = now
    }

    // 現在表情ラベル描画
    ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(0, H-48, W, 48)
    ctx.font = 'bold 16px sans-serif'; ctx.textAlign = 'center'
    ctx.fillStyle = '#aaa'; ctx.fillText('カメラに顔を向けてください', W/2, H-18)

    rafRef.current = requestAnimationFrame(loop)
  }, [])

  // ── スタート ──
  const startGame = async () => {
    setPhase('loading')
    try {
      setStatus('📷 カメラ起動中...')
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode:'user', width:640, height:360 }, audio:false
      })
      const v = videoRef.current
      v.srcObject = stream
      await new Promise((res,rej) => { v.onloadeddata=res; v.onerror=rej; v.play().catch(rej); setTimeout(res,3000) })

      if (!detRef.current) await loadModel()

      const g = gRef.current
      Object.assign(g, { running:true, score:0, exprIdx:0, conf:0, holdStart:null, lastTime:0, exprStart:Date.now() })
      setScore(0); setExprIdx(0); setConf(0); setTimeLeft(TOTAL_SEC); setSkipLeft(SKIP_SEC); setSkipped(false)

      setPhase('play')
      requestAnimationFrame(loop)

      // タイマー
      let t = TOTAL_SEC
      const timer = setInterval(() => {
        t--; setTimeLeft(t)
        if (t <= 0) {
          clearInterval(timer)
          g.running = false
          cancelAnimationFrame(rafRef.current)
          setPhase('over')
        }
      }, 1000)

    } catch(err) {
      setStatus(`❌ ${err.message}`)
      setTimeout(() => setPhase('title'), 3000)
    }
  }

  useEffect(() => () => {
    gRef.current.running = false
    cancelAnimationFrame(rafRef.current)
    videoRef.current?.srcObject?.getTracks().forEach(t=>t.stop())
  }, [])

  const expr = EXPRESSIONS[exprIdx]
  const pct  = Math.round(conf * 100)
  const W = 640, H = 360

  const panelStyle = {
    width: W, height: H, borderRadius:18,
    background:'#1a1a2e', display:'flex', flexDirection:'column',
    alignItems:'center', justifyContent:'center', gap:20, maxWidth:'100%',
  }

  return (
    <div style={{
      minHeight:'100vh',
      background:'linear-gradient(135deg,#1a0533,#0d1b4b,#001a2e)',
      display:'flex', flexDirection:'column', alignItems:'center',
      justifyContent:'center', fontFamily:'"Helvetica Neue",sans-serif',
      color:'#fff', padding:16,
    }}>
      <h1 style={{ fontSize:24, fontWeight:800, margin:'0 0 14px', letterSpacing:0.5 }}>
        🎭 表情マッチゲーム
      </h1>

      {/* ── メインエリア ── */}
      <div style={{ display:'flex', gap:16, alignItems:'stretch', flexWrap:'wrap', justifyContent:'center' }}>

        {/* カメラCanvas */}
        <div style={{ position:'relative' }}>
          <video ref={videoRef} autoPlay muted playsInline style={{ display:'none' }} />
          <canvas ref={canvasRef} width={W} height={H} style={{
            borderRadius:18, maxWidth:'100%',
            display: phase==='play' ? 'block' : 'none',
            boxShadow:'0 8px 40px rgba(0,0,0,0.6)',
            outline: flash ? `6px solid ${expr.color}` : 'none',
            transition:'outline 0.1s',
          }} />

          {phase==='title' && <div style={panelStyle}>
            <div style={{ fontSize:72 }}>🎭</div>
            <div style={{ textAlign:'center', color:'#ccc', fontSize:15, lineHeight:1.9, maxWidth:360 }}>
              AIが顔の表情を読み取る！<br/>
              表示されたお題の表情を<br/>カメラの前でやってみよう！
            </div>
            <button onClick={startGame} style={btnStyle('#ff6b9d','#ff8c42')}>🎮 スタート！</button>
          </div>}

          {phase==='loading' && <div style={panelStyle}>
            <div style={{ fontSize:52 }}>⏳</div>
            <div style={{ fontSize:16, color:'#aaa' }}>{status}</div>
            <div style={{ fontSize:12, color:'#555', maxWidth:360, textAlign:'center' }}>
              初回はAIモデルのダウンロードに<br/>少し時間がかかります
            </div>
          </div>}

          {phase==='over' && <div style={{
            position:'absolute', inset:0, background:'rgba(0,0,0,0.88)',
            borderRadius:18, display:'flex', flexDirection:'column',
            alignItems:'center', justifyContent:'center', gap:18,
          }}>
            <div style={{ fontSize:62 }}>🏆</div>
            <div style={{ fontSize:28, fontWeight:800 }}>ゲーム終了！</div>
            <div style={{ fontSize:22, color:'#FFD700' }}>{score} 表情マッチ！</div>
            <div style={{ fontSize:14, color:'#888' }}>
              {score >= 15 ? '表情の達人！😍' : score >= 8 ? 'なかなかやるね😄' : 'もう一回チャレンジ！💪'}
            </div>
            <button onClick={startGame} style={btnStyle('#43e97b','#38f9d7')}>🔄 もう一回！</button>
          </div>}
        </div>

        {/* ── お題パネル ── */}
        {phase === 'play' && (
          <div style={{
            width:200, background:'rgba(255,255,255,0.05)',
            borderRadius:18, padding:'24px 16px',
            display:'flex', flexDirection:'column',
            alignItems:'center', justifyContent:'space-between',
            backdropFilter:'blur(10px)', border:'1px solid rgba(255,255,255,0.1)',
          }}>
            {/* タイマー + スコア */}
            <div style={{ width:'100%', display:'flex', justifyContent:'space-between', fontSize:13, color:'#aaa' }}>
              <span>⏱ {timeLeft}s</span>
              <span>✅ {score}個</span>
            </div>

            {/* お題 */}
            <div style={{ textAlign:'center' }}>
              <div style={{ fontSize:11, color:'#888', marginBottom:8, letterSpacing:1 }}>お題</div>
              <div style={{
                fontSize:90, lineHeight:1,
                filter: flash ? `drop-shadow(0 0 20px ${expr.color})` : skipped ? 'grayscale(1)' : 'none',
                transition:'filter 0.1s',
              }}>{expr.emoji}</div>
              <div style={{ fontSize:20, fontWeight:800, marginTop:12, color: skipped ? '#FF6644' : expr.color }}>
                {skipped ? '💨 スキップ！' : expr.label}
              </div>
              {/* スキップカウントダウン */}
              <div style={{ marginTop:8, fontSize:12, color: skipLeft <= 3 ? '#FF6644' : '#555', fontWeight: skipLeft <= 3 ? 700 : 400 }}>
                {skipLeft <= 3 ? `⚠️ あと${skipLeft}秒…` : `残り ${skipLeft}秒`}
              </div>
            </div>

            {/* 信頼度メーター */}
            <div style={{ width:'100%' }}>
              <div style={{ fontSize:12, color:'#888', marginBottom:6, textAlign:'center' }}>
                一致度: {pct}%
              </div>
              {/* スキップ進捗バー */}
              <div style={{
                width:'100%', height:4, background:'rgba(255,255,255,0.08)',
                borderRadius:4, marginBottom:8, overflow:'hidden',
              }}>
                <div style={{
                  height:'100%', borderRadius:4,
                  width: `${((SKIP_SEC - skipLeft) / SKIP_SEC) * 100}%`,
                  background: skipLeft <= 3 ? '#FF6644' : '#555',
                  transition:'width 0.5s linear',
                }} />
              </div>
              <div style={{
                width:'100%', height:16, background:'rgba(255,255,255,0.1)',
                borderRadius:8, overflow:'hidden',
              }}>
                <div style={{
                  height:'100%', borderRadius:8,
                  width: `${pct}%`,
                  background: pct >= 100
                    ? '#43e97b'
                    : `linear-gradient(90deg,${expr.color}88,${expr.color})`,
                  transition:'width 0.15s ease-out',
                }} />
              </div>
              {pct >= 100 && (
                <div style={{ textAlign:'center', marginTop:8, fontSize:12, color:'#43e97b', fontWeight:700 }}>
                  そのまま維持して！🎯
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {phase === 'play' && (
        <p style={{ marginTop:10, fontSize:11, color:'#444' }}>
          各表情を {HOLD_MS/1000}秒キープすると次のお題へ • {TOTAL_SEC}秒間で何個マッチできる？
        </p>
      )}

      {/* ── デバッグパネル ── */}
      {phase === 'play' && dbgBS.length > 0 && (
        <div style={{
          marginTop:14, background:'rgba(0,0,0,0.6)',
          borderRadius:12, padding:'12px 16px',
          width: 680, maxWidth:'100%',
          fontFamily:'monospace', fontSize:12,
        }}>
          <div style={{ color:'#888', marginBottom:8 }}>
            🔍 ブレンドシェイプ（上位10件） — お題: {EXPRESSIONS[exprIdx].emoji} {EXPRESSIONS[exprIdx].id}
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'4px 16px' }}>
            {dbgBS.map(b => (
              <div key={b.categoryName} style={{ display:'flex', alignItems:'center', gap:8 }}>
                <span style={{ color:'#aaa', minWidth:220 }}>{b.categoryName}</span>
                <div style={{ flex:1, height:8, background:'#222', borderRadius:4, overflow:'hidden' }}>
                  <div style={{
                    height:'100%', borderRadius:4,
                    width: `${b.score * 100}%`,
                    background: b.score > 0.5 ? '#43e97b' : b.score > 0.25 ? '#FFD700' : '#555',
                  }} />
                </div>
                <span style={{ color:'#fff', minWidth:38, textAlign:'right' }}>
                  {(b.score * 100).toFixed(0)}%
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function btnStyle(c1, c2) {
  return {
    background: `linear-gradient(135deg,${c1},${c2})`,
    border:'none', borderRadius:14, padding:'13px 44px',
    fontSize:17, fontWeight:800, color:'#111', cursor:'pointer',
    boxShadow:`0 4px 20px ${c1}88`,
  }
}
