import { useCallback, useEffect, useState } from "react"

type Theme = "light" | "dark"

function getStoredTheme(): Theme {
  if (typeof window === "undefined") return "dark"
  return (localStorage.getItem("theme") as Theme) || "dark"
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(getStoredTheme)

  useEffect(() => {
    const root = document.documentElement
    if (theme === "dark") {
      root.classList.add("dark")
    } else {
      root.classList.remove("dark")
    }
    root.style.colorScheme = theme
    root.style.backgroundColor = theme === "dark" ? "#0f0f10" : "#f6f7f6"
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", theme === "dark" ? "#0f0f10" : "#f6f7f6")
    localStorage.setItem("theme", theme)
  }, [theme])

  const toggleTheme = useCallback(() => {
    setThemeState((prev) => (prev === "dark" ? "light" : "dark"))
  }, [])

  return { theme, toggleTheme }
}
