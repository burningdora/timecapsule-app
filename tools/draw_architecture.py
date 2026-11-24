# -*- coding: utf-8 -*-
"""Рисует docs/architecture.png — схему фоновой обработки TimeCapsule (ЛР7, часть 2)."""
import math
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")

from PIL import Image, ImageDraw, ImageFont

W, H = 1600, 780
BG = "#ffffff"
BOX = "#f4f7fb"
EDGE = "#8fa3bf"
TEXT = "#12233b"
ARROW = "#3b5b86"
GREEN = "#2f7d4f"
RED = "#b23b3b"

FONT = r"C:\Windows\Fonts\arial.ttf"
FONT_B = r"C:\Windows\Fonts\arialbd.ttf"


def f(size, bold=False):
    return ImageFont.truetype(FONT_B if bold else FONT, size)


img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)


def box(x, y, w, h, title, lines=(), title_size=19, line_size=15):
    d.rounded_rectangle([x, y, x + w, y + h], radius=12, fill=BOX, outline=EDGE, width=2)
    ty = y + 13
    tw = d.textlength(title, font=f(title_size, True))
    d.text((x + (w - tw) / 2, ty), title, font=f(title_size, True), fill=TEXT)
    ty += title_size + 10
    for ln in lines:
        lw = d.textlength(ln, font=f(line_size))
        d.text((x + (w - lw) / 2, ty), ln, font=f(line_size), fill="#41506b")
        ty += line_size + 5


def head(x1, y1, x2, y2, color):
    ang = math.atan2(y2 - y1, x2 - x1)
    for s in (0.45, -0.45):
        d.line([x2, y2, x2 - 15 * math.cos(ang - s), y2 - 15 * math.sin(ang - s)],
               fill=color, width=3)


def poly(points, label="", color=ARROW, lpos=None, size=13):
    d.line(points, fill=color, width=3, joint="curve")
    head(points[-2][0], points[-2][1], points[-1][0], points[-1][1], color)
    if label:
        fnt = f(size)
        tw = d.textlength(label, font=fnt)
        lx, ly = lpos if lpos else (points[0][0] + 10, points[0][1] - 20)
        d.rectangle([lx - 4, ly - 2, lx + tw + 4, ly + size + 4], fill=BG)
        d.text((lx, ly), label, font=fnt, fill="#5b6b86")


# --- блоки ---
box(60, 60, 220, 100, "Браузер", ["пользователь", "POST /seal"])
box(340, 50, 320, 120, "EC2 web  (Node.js)", ["TimeCapsule, MAIL_MODE=sns",
                                              "ответ за 40–100 мс"], title_size=20)
box(340, 300, 320, 110, "RDS PostgreSQL", ["capsules", "notifications (unique)"])
box(760, 40, 340, 130, "SNS topic", ["timecapsule-dev-events",
                                     "фильтры по телу сообщения"], title_size=20)

box(1200, 30, 330, 100, "SQS timecapsule-dev-mail",
    ["maxReceiveCount = 3", "Visibility 120 с", "фильтр: capsule.sealed"],
    title_size=18, line_size=14)
box(1200, 200, 330, 110, "Lambda mailer", ["timecapsule-dev-mailer",
                                           "батч 1, ≤ 2 вызовов"])
box(1200, 380, 330, 90, "DLQ timecapsule-dev-mail-dlq", ["хранение 14 суток"],
    title_size=17, line_size=14)
box(1200, 540, 330, 110, "E-mail подписка", ["фильтр: capsule.opened,",
                                             "count > 0"])

box(300, 450, 340, 100, "EventBridge Scheduler", ["rate(1 minute)"])
box(760, 450, 340, 110, "Lambda opener", ["timecapsule-dev-opener",
                                          "открывает созревшие капсулы"])

# --- связи ---
poly([(280, 110), (336, 110)], "HTTP", lpos=(286, 84))
poly([(500, 170), (500, 296)], "SQL", lpos=(508, 222))
poly([(660, 110), (756, 110)], "capsule.sealed", lpos=(664, 118))

poly([(1100, 85), (1196, 85)], "фильтр в SNS", lpos=(1106, 58), size=12)
poly([(1365, 130), (1365, 196)])
poly([(1290, 310), (1290, 376)], "3 неудачных приёма", lpos=(1298, 336), color=RED, size=12)

# opener → SNS (асинхронное назначение «при успехе»)
poly([(930, 446), (930, 174)], "async destination (OnSuccess)", lpos=(900, 286), color=GREEN)

# SNS → e-mail
poly([(1100, 150), (1160, 150), (1160, 595), (1196, 595)],
     "письмо capsule.opened", lpos=(964, 574), color=GREEN)

# расписание → opener
poly([(640, 500), (756, 500)], "раз в минуту", lpos=(646, 474))

# mailer → RDS
poly([(1196, 255), (1120, 255), (1120, 650), (700, 650), (700, 360), (684, 360)],
     "SQL", lpos=(736, 656))

# --- пояснения ---
d.text((62, 200), "синхронный запрос:", font=f(13), fill="#8a97ab")
d.text((62, 220), "не ждёт почтовый сервер", font=f(13), fill="#8a97ab")
d.text((62, 600), "фоновая обработка:", font=f(13), fill="#8a97ab")
d.text((62, 620), "по событиям и расписанию", font=f(13), fill="#8a97ab")

d.line([60, 700, 1540, 700], fill="#e3e8ef", width=2)
d.text((60, 716), "Доставка at-least-once: повторный вызов не создаёт дубль —",
       font=f(15), fill="#41506b")
d.text((60, 740), "в notifications стоит unique (capsule_id, kind) + ON CONFLICT DO NOTHING.",
       font=f(15), fill="#41506b")

out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   "docs", "architecture.png")
os.makedirs(os.path.dirname(out), exist_ok=True)
img.save(out)
print("сохранено:", out, img.size)
