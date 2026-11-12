import { Spinner } from './ui'

export function Splash() {
  return (
    <div className="splash">
      <img src="./deepwhale.png" alt="" className="splash-icon" />
      <div className="splash-title">深鲸</div>
      <div className="splash-sub">正在下潜…</div>
      <Spinner small />
    </div>
  )
}
