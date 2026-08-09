import IconButton from './IconButton'

interface Props {
  onPress: () => void
  hitSlop?: number
  size?: number
  // Accent it where a note already exists (see HighlightCard `hasNote`).
  color?: string
}

// Note/annotate action button — tilted pencil. Use everywhere a note action appears.
export default function NoteEditButton({ onPress, hitSlop = 8, size = 14, color }: Props) {
  return <IconButton name="create-outline" onPress={onPress} hitSlop={hitSlop} size={size} color={color} />
}
