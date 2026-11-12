/** What the orca says when the body is touched or the bubble is tapped. */
const POKES = [
  '咕噜。',
  '再摸一下？',
  '我在这儿呢。',
  '鳍都软了。',
  '别挠下巴…',
  '今天也很努力地当鲸。',
  '被你戳到了。',
  '海水是温的。',
]

export function randomPoke(): string {
  return POKES[Math.floor(Math.random() * POKES.length)] as string
}
