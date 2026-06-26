import IconButton from './IconButton'

interface Props {
  onPress: () => void
  hitSlop?: number
  size?: number
}

// Note/annotate action button — tilted pencil. Use everywhere a note action appears.
export default function NoteEditButton({ onPress, hitSlop = 8, size = 14 }: Props) {
  return <IconButton name="create-outline" onPress={onPress} hitSlop={hitSlop} size={size} />
}
