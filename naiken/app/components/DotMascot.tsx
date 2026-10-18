/** Official dots portrait: https://learn.chatgpt.com/docs/dots */
export default function DotMascot({ className = '' }: { className?: string }) {
  return <img className={`dot-mascot ${className}`} src="/images/dot-alfred.webp" width="192" height="192" alt="dotsのキャラクター Alfred" draggable={false}/>;
}
