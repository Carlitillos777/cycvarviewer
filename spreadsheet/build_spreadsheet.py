"""Rebuilds Cycvar_Speed_Tests.xlsx from the original workbook + the 6-slice runs below.
Usage: python build_spreadsheet.py Cycvar_Speed_Tests.xlsx
(Formulas have no cached values until opened in Excel/LibreOffice.)"""
import openpyxl, sys
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.worksheet.table import Table, TableStyleInfo
from openpyxl.chart import LineChart, Reference
from openpyxl.chart.layout import Layout, ManualLayout
from openpyxl.comments import Comment

import os
HERE = os.path.dirname(os.path.abspath(__file__))
src = openpyxl.load_workbook(os.path.join(HERE, 'original', 'Cycvar_Speed_Tests_original.xlsx'))['Hoja 1']
REN = {'Wave1':'Wavetech Project 1','Wave5':'Wavetech Project 5','Hermit1':'Hermit 1 Set','Hermit2':'Hermit 2 Set'}
TESTS = [REN.get(t,t) for t in ['Wave1','Wave5','Quarry','SciCraftMooshroom','Hermit1','Hermit2','EasyTest']]
rows = [[src.cell(r,c).value for c in range(1,7)] for r in range(2,44)]
assert len(rows) == 42
for r in rows: r[1] = REN.get(r[1], r[1])
# rows labelled 6 are really 5 slices
for r in rows:
    if r[0] == 6: r[0] = 5
# derived columns must match the formulas we'll write
for s,t,v,m,i,tm in rows:
    assert abs(round(v/9000,2)-m) < 0.006, (s,t,m)
# 6-slice data from the new test runs (speed, items, time)
SIX = {'Wave1':(56144,43650,46.65),'Wave5':(58447,26991,27.71),'Quarry':(110954,71322,38.57),'SciCraftMooshroom':(60604,43623,43.19),
       'Hermit1':(28194,59118,125.81),'Hermit2':(20138,50261,149.75),'EasyTest':(69263,11692,10.13)}
SIX = {REN.get(k,k):v for k,v in SIX.items()}
for t,(v,i,tm6) in SIX.items():
    assert any(r[1]==t and r[4]==i for r in rows)  # item counts match existing
    assert abs(i/v*60 - tm6) < 0.05, t
    rows.append([6,t,v,None,i,tm6])
rows.sort(key=lambda r:(r[0], TESTS.index(r[1])))
SL = [2,3,4,5,6,7,8]
assert [ (r[0],r[1]) for r in rows] == [(s,t) for s in SL for t in TESTS]

wb = openpyxl.Workbook(); ws = wb.active; ws.title = 'Dashboard'
BLUE, GREEN, INK = '3B5F90', '3A6939', '181C1F'
HF = lambda: Font(name='Montserrat', size=11, bold=True, color='FFFFFF')
BF = lambda **k: Font(name='Roboto', size=10, color=INK, **k)
fill = lambda c: PatternFill('solid', fgColor=c)
thin = Side(style='thin', color='D0D5DB'); box = Border(left=thin,right=thin,top=thin,bottom=thin)
C = Alignment(horizontal='center', vertical='center', wrap_text=True)
ws.sheet_view.showGridLines = False

def title(cell, text, color):
    ws[cell] = text; ws[cell].font = Font(name='Montserrat', size=14, bold=True, color=color)

# ---------- left: item counts, then raw data ----------
def header(row, labels, color):
    for j,h in enumerate(labels,1):
        c = ws.cell(row,j,h); c.font = HF(); c.fill = fill(color); c.alignment = C
def body(c, fmt, left=False, band=False):
    c.font = BF(); c.number_format = fmt; c.border = box
    c.alignment = Alignment(horizontal='left' if left else 'center')
    if band: c.fill = fill('EEF3EC')

ITEMS = {}
for s_,t,v,_,i,tm in rows: ITEMS.setdefault(t, i); assert ITEMS[t] == i
title('A1', 'Items per test', GREEN)
header(3, ['#','Test Name','Items Count'], GREEN)
for k,t in enumerate(TESTS):
    r = 4+k
    body(ws.cell(r,1,k+1), '0', band=k%2==1); body(ws.cell(r,2,t), '@', left=True, band=k%2==1)
    body(ws.cell(r,3,ITEMS[t]), '#,##0', band=k%2==1)
it = Table(displayName='ItemCounts', ref='A3:C10')
it.tableStyleInfo = TableStyleInfo(name='TableStyleLight1', showRowStripes=False)
ws.add_table(it)

title('A12', 'Raw data', GREEN)
H0 = 14
header(H0, ['Slice Count','Test Name','Speed (items/h)','Hopper Multiplier (x)','Time (min)'], GREEN)
first = H0+1; last = H0+len(rows)
for k,(s,t,v,_,i,tm) in enumerate(rows):
    r = first+k
    ws.cell(r,1,s); ws.cell(r,2,t); ws.cell(r,3,v); ws.cell(r,4,f'=C{r}/9000'); ws.cell(r,5,tm)
    for j,fmt in enumerate(['0','@','#,##0','0.00','0.00'],1):
        body(ws.cell(r,j), fmt, left=(j==2), band=(s % 2 == 0))
tab = Table(displayName='RawData', ref=f'A{H0}:E{last}')
tab.tableStyleInfo = TableStyleInfo(name='TableStyleLight1', showRowStripes=False)
ws.add_table(tab)
ws.cell(last+2,1,'Hopper Multiplier = Speed ÷ 9,000 items/h (one hopper).').font = BF(italic=True)
for col,w in zip('ABCDE',[11,20,16,22,12]): ws.column_dimensions[col].width = w
ws.column_dimensions['F'].width = 2; ws.column_dimensions['G'].width = 3

# ---------- right: matrices H:O ----------
COLS = 'IJKLMNO'
def matrix(top, name, color, cellf, fmt):
    title(f'H{top}', name, color)
    h = top+2
    c = ws.cell(h,8,'Slices'); c.font = HF(); c.fill = fill(BLUE); c.alignment = C
    for j,t in enumerate(TESTS):
        c = ws.cell(h,9+j,t); c.font = HF(); c.fill = fill(BLUE); c.alignment = C
    for k,s in enumerate(SL):
        r = h+1+k
        c = ws.cell(r,8,s); c.font = BF(bold=True); c.alignment = C; c.border = box; c.fill = fill('E4EAF2')
        for j in range(7):
            c = ws.cell(r,9+j,cellf(r,COLS[j],h)); c.font = BF(); c.number_format = fmt; c.alignment = C; c.border = box
            if k % 2: c.fill = fill('F4F6F9')
    return h
A = f'$A${first}:$A${last}'; B = f'$B${first}:$B${last}'; V = f'$C${first}:$C${last}'
sp_h = matrix(1, 'Speed (items/h)', BLUE, lambda r,col,h: f'=SUMIFS({V},{A},$H{r},{B},{col}${h})', '#,##0')
gn_off = 11
gn_h = matrix(12, '% Gain vs 2 slices', BLUE, lambda r,col,h: f'={col}{r-gn_off}/{col}${sp_h+1}-1', '0.0%')
pv_h = matrix(23, '% Gain vs previous slice count', BLUE, lambda r,col,h: '–' if r == h+1 else f'={col}{r-22}/{col}{r-23}-1', '0.0%')
assert pv_h == 25 and sp_h == 3
ef_h = matrix(34, 'Scaling efficiency vs perfect scaling', BLUE, lambda r,col,h: f'={col}{r-33}/({col}${sp_h+1}*$H{r}/2)', '0.0%')
assert ef_h == 36
c = ws.cell(35, 8, '100% = speed grows in proportion to slices (e.g. 4 slices = 2× the 2-slice speed).'); c.font = BF(italic=True)
ws.column_dimensions['H'].width = 9
for col in COLS: ws.column_dimensions[col].width = 13
ws.column_dimensions['L'].width = 20
for col in 'IJ': ws.column_dimensions[col].width = 22

# ---------- charts: three full-width comparison charts under the tables ----------
from openpyxl.chart import BarChart, Series
from openpyxl.chart.series import SeriesLabel, StrRef
W, H = 24.6, 9.5
def style(ch, t, fmt, ytitle):
    ch.title = t; ch.style = 2; ch.width, ch.height = W, H
    ch.x_axis.title = 'Slices'; ch.y_axis.title = ytitle; ch.y_axis.numFmt = fmt
    ch.x_axis.delete = False; ch.y_axis.delete = False; ch.legend.position = 'b'
def lines(ch):
    for s in ch.series: s.marker.symbol = 'circle'; s.marker.size = 5; s.smooth = False

ch = LineChart(); style(ch, 'Speed — all tests', '#,##0', 'items/h')
ch.add_data(Reference(ws, min_col=9, max_col=15, min_row=sp_h, max_row=sp_h+7), titles_from_data=True)
ch.set_categories(Reference(ws, min_col=8, min_row=sp_h+1, max_row=sp_h+7)); lines(ch)
ws.add_chart(ch, 'H46')

ch = LineChart(); style(ch, '% gain vs 2 slices — all tests', '0%', 'gain')
ch.add_data(Reference(ws, min_col=9, max_col=15, min_row=gn_h, max_row=gn_h+7), titles_from_data=True)
ch.set_categories(Reference(ws, min_col=8, min_row=gn_h+1, max_row=gn_h+7)); lines(ch)
ws.add_chart(ch, 'H66')

ch = BarChart(); ch.type = 'col'; ch.grouping = 'clustered'; ch.gapWidth = 60
style(ch, '% gain vs previous slice count', '0%', 'gain')
for j in range(7):
    col = 9 + j; L = COLS[j]
    se = Series(Reference(ws, min_col=col, min_row=pv_h+2, max_row=pv_h+7))
    se.tx = SeriesLabel(strRef=StrRef(f"'Dashboard'!${L}${pv_h}"))
    ch.series.append(se)
ch.set_categories(Reference(ws, min_col=8, min_row=pv_h+2, max_row=pv_h+7))
ws.add_chart(ch, 'H86')

ch = LineChart(); style(ch, 'Scaling efficiency — all tests', '0%', 'efficiency')
ch.add_data(Reference(ws, min_col=9, max_col=15, min_row=ef_h, max_row=ef_h+7), titles_from_data=True)
ch.set_categories(Reference(ws, min_col=8, min_row=ef_h+1, max_row=ef_h+7)); lines(ch)
ch.y_axis.scaling.min = 0; ch.y_axis.scaling.max = 1
ws.add_chart(ch, 'H106')

for r in range(1,130): ws.row_dimensions[r].height = 16
ws.row_dimensions[1].height = 22
ws.row_dimensions[3].height = 30; ws.row_dimensions[14].height = 30
ws.page_setup.orientation = 'portrait'; ws.page_setup.fitToWidth = 1; ws.page_setup.fitToHeight = 1
ws.sheet_properties.pageSetUpPr.fitToPage = True
ws.print_area = 'A1:O125'
wb.save(sys.argv[1]); print('saved', last)
