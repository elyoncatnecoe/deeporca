import { useAppStore } from '../lib/store'

export function Toast() {
  const toast = useAppStore((state) => state.toast)
  if (toast === '') return null
  return (
    <div className="toast" role="status">
      {toast}
    </div>
  )
}
