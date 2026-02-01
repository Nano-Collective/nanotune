import { Text } from "ink";

interface StatusBadgeProps {
  status: "success" | "error" | "warning" | "pending" | "running";
  label?: string;
}

export function StatusBadge({ status, label }: StatusBadgeProps) {
  const icons: Record<string, { icon: string; color: string }> = {
    success: { icon: "\u2713", color: "green" },
    error: { icon: "\u2717", color: "red" },
    warning: { icon: "!", color: "yellow" },
    pending: { icon: "\u25CB", color: "gray" },
    running: { icon: "\u25CF", color: "blue" },
  };

  const { icon, color } = icons[status];

  return (
    <Text color={color}>
      {icon}
      {label && ` ${label}`}
    </Text>
  );
}
