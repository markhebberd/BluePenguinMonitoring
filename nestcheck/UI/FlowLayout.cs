using Android.Content;
using Android.Views;

namespace PenguinMonitor.UI
{
    /// <summary>
    /// A simple flow layout that wraps children to the next line when they don't fit.
    /// </summary>
    public class FlowLayout : ViewGroup
    {
        public int HorizontalSpacing { get; set; }
        public int VerticalSpacing { get; set; }

        /// <summary>
        /// When true and the children don't all fit on one row, the first child is kept on its own
        /// row and the rest flow from the row below. When everything fits, the first child shares the
        /// row as normal. Use for "Box X + mini-views": together on one line, else Box X alone on top.
        /// </summary>
        public bool BreakAfterFirstWhenWrapping { get; set; }

        public FlowLayout(Context context) : base(context) { }

        // Total width of all (already-measured) children plus the spacing between them.
        private int TotalRowWidth()
        {
            int total = 0;
            for (int i = 0; i < ChildCount; i++)
                total += GetChildAt(i)!.MeasuredWidth + (i > 0 ? HorizontalSpacing : 0);
            return total;
        }

        protected override void OnMeasure(int widthMeasureSpec, int heightMeasureSpec)
        {
            int maxWidth = MeasureSpec.GetSize(widthMeasureSpec);
            // Always measure every child first — the layout loop below reads MeasuredWidth/Height.
            for (int i = 0; i < ChildCount; i++)
                GetChildAt(i)!.Measure(MeasureSpec.MakeMeasureSpec(maxWidth, MeasureSpecMode.AtMost),
                    MeasureSpec.MakeMeasureSpec(0, MeasureSpecMode.Unspecified));
            bool breakAfterFirst = BreakAfterFirstWhenWrapping && ChildCount > 1 && TotalRowWidth() > maxWidth;
            int x = 0, y = 0, rowHeight = 0;

            for (int i = 0; i < ChildCount; i++)
            {
                var child = GetChildAt(i)!;
                int childWidth = child.MeasuredWidth + (x > 0 ? HorizontalSpacing : 0);
                bool forceBreak = breakAfterFirst && i == 1;
                if ((x + childWidth > maxWidth || forceBreak) && x > 0)
                {
                    x = 0;
                    y += rowHeight + VerticalSpacing;
                    rowHeight = 0;
                    childWidth = child.MeasuredWidth;
                }
                x += childWidth;
                rowHeight = System.Math.Max(rowHeight, child.MeasuredHeight);
            }

            SetMeasuredDimension(maxWidth, y + rowHeight);
        }

        protected override void OnLayout(bool changed, int l, int t, int r, int b)
        {
            int maxWidth = r - l;
            bool breakAfterFirst = BreakAfterFirstWhenWrapping && ChildCount > 1 && TotalRowWidth() > maxWidth;
            int x = 0, y = 0, rowHeight = 0;

            for (int i = 0; i < ChildCount; i++)
            {
                var child = GetChildAt(i)!;
                int spacing = x > 0 ? HorizontalSpacing : 0;
                bool forceBreak = breakAfterFirst && i == 1;
                if ((x + spacing + child.MeasuredWidth > maxWidth || forceBreak) && x > 0)
                {
                    x = 0;
                    y += rowHeight + VerticalSpacing;
                    rowHeight = 0;
                    spacing = 0;
                }
                child.Layout(x + spacing, y, x + spacing + child.MeasuredWidth, y + child.MeasuredHeight);
                x += spacing + child.MeasuredWidth;
                rowHeight = System.Math.Max(rowHeight, child.MeasuredHeight);
            }
        }
    }
}
