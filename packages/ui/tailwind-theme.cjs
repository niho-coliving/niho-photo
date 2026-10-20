/** NIHO photo / NIHO docs共通の色・動きの定義。 */
module.exports = {
  extend: {
      colors: {
        niho: {
          DEFAULT: 'var(--niho)',
          soft: 'var(--niho-soft)',
          deep: 'var(--niho-deep)',
          dark: 'var(--niho-dark)',
          'dark-hover': 'var(--niho-dark-hover)',
          accent: 'var(--niho-accent)',
          'accent-hover': 'var(--niho-accent-hover)',
          'accent-ink': 'var(--niho-accent-ink)',
          'accent-soft': 'var(--niho-accent-soft)',
          pale: 'var(--niho-pale)',
          'gradient-from': 'var(--niho-gradient-from)',
          'gradient-to': 'var(--niho-gradient-to)',
          surface: 'var(--niho-surface)',
          'surface-warm': 'var(--niho-surface-warm)',
          'surface-cream': 'var(--niho-surface-cream)',
                  'surface-subtle': 'var(--niho-surface-subtle)',
                  // NIHO docs（/app/docs）の地（owner 2026-10-18・Claude のアプリの地と同じ。値の正は globals.css）
                  'docs-surface': 'var(--niho-docs-surface)',
          text: 'var(--niho-text)',
          'text-sub': 'var(--niho-text-sub)',
          'text-muted': 'var(--niho-text-muted)',
          border: 'var(--niho-border)',
          orange: 'var(--niho-orange)',
          'orange-pale': 'var(--niho-orange-pale)',
          notify: 'var(--niho-notify)',
          danger: 'var(--niho-danger)',
          mention: 'var(--niho-mention)',
          'mention-hover': 'var(--niho-mention-hover)',
          'mention-soft': 'var(--niho-mention-soft)',
          info: 'var(--niho-info)',
          'info-soft': 'var(--niho-info-soft)',
          'info-border': 'var(--niho-info-border)',
        },
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          light: '#A8C986',
          lighter: '#BCD499',
          foreground: 'hsl(var(--primary-foreground))'
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))'
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))'
        },
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))'
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))'
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))'
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))'
        },
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        chart: {
          '1': 'hsl(var(--chart-1))',
          '2': 'hsl(var(--chart-2))',
          '3': 'hsl(var(--chart-3))',
          '4': 'hsl(var(--chart-4))',
          '5': 'hsl(var(--chart-5))'
        }
      },
      fontFamily: {
        // App Sans の正は globals.css の --font-family-sans（NIHO Sans alias）。
        // `font-sans` utility と Preflight の既定書体をそこへ揃える（#16764）。
        sans: ['var(--font-family-sans)']
      },
    fontSize: {
      // 2026-06 タイプスケール改定（床12px・本文15px・天井維持）。
      // スケール全体の正は docs/design/design-guide.md §4、移行手順は
      // docs/design/type-scale-migration-2026-06.md を参照。
      // fine(11px) は装飾マイクロ専用。情報を運ぶテキストの床は text-xs(12px)。
      'body': ['0.9375rem', { lineHeight: '1.6' }], // 15px 標準本文
      'sub': ['0.8125rem', { lineHeight: '1.5' }], // 13px 補助テキスト
      'fine': ['0.6875rem', { lineHeight: '1.3' }], // 11px 装飾マイクロ
    },
      maxWidth: {
        phone: '430px'
      },
      boxShadow: {
        niho: '0 6px 24px rgba(0,0,0,0.12)'
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)'
      },
      keyframes: {
        'slide-up': {
          '0%': { transform: 'translateY(100%)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' }
        },
        'slide-down': {
          '0%': { transform: 'translateY(0)', opacity: '1' },
          '100%': { transform: 'translateY(100%)', opacity: '0' }
        },
        'fadeIn': {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' }
        },
        'pop-in': {
          '0%': { opacity: '0', transform: 'translateY(8px) scale(0.97)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' }
        }
      },
      animation: {
        'slide-up': 'slide-up 0.3s ease-out',
        'slide-down': 'slide-down 0.16s ease-in',
        'fadeIn': 'fadeIn 0.3s ease-out',
        'pop-in': 'pop-in 0.26s cubic-bezier(0.22, 1, 0.36, 1) backwards'
      }
  },
};
