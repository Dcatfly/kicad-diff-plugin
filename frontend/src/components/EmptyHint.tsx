export default function EmptyHint({ text }: { text: string }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
      <span className="text-sm text-text-secondary">{text}</span>
    </div>
  )
}
