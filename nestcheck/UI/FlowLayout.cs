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

        public FlowLayout(Context context) : base(context) { }

        protected override void OnMeasure(int widthMeasureSpec, int heightMeasureSpec)
        {
            int maxWidth = MeasureSpec.GetSize(widthMeasureSpec);
            int x = 0, y = 0, rowHeight = 0;

            for (int i = 0; i < ChildCount; i++)
            {
                var child = GetChildAt(i)!;
                child.Measure(MeasureSpec.MakeMeasureSpec(maxWidth, MeasureSpecMode.AtMost),
                    MeasureSpec.MakeMeasureSpec(0, MeasureSpecMode.Unspecified));
                int childWidth = child.MeasuredWidth + (x > 0 ? HorizontalSpacing : 0);
                if (x + childWidth > maxWidth && x > 0)
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
            int x = 0, y = 0, rowHeight = 0;

            for (int i = 0; i < ChildCount; i++)
            {
                var child = GetChildAt(i)!;
                int spacing = x > 0 ? HorizontalSpacing : 0;
                if (x + spacing + child.MeasuredWidth > maxWidth && x > 0)
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
