/** Material Symbols Outlined 图标封装：全部图标走这个组件。 */
export function Icon({ name, size }: { name: string; size?: number }) {
  return (
    <span
      className="material-symbols-outlined"
      aria-hidden="true"
      style={size ? { fontSize: size } : undefined}
    >
      {name}
    </span>
  );
}
