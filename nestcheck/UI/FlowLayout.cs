using Android.Content;
using Android.Views;

namespace PenguinMonitor.UI
{
    /// <summary>
    /// A simple flow layout that wraps children to the next line when they don't fit.
    /// </summary>
    public class FlowLayout : ViewGroup
    {
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
                if (x + child.MeasuredWidth > maxWidth && x > 0)
                {
                    x = 0;
                    y += rowHeight;
                    rowHeight = 0;
                }
                x += child.MeasuredWidth;
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
                if (x + child.MeasuredWidth > maxWidth && x > 0)
                {
                    x = 0;
                    y += rowHeight;
                    rowHeight = 0;
                }
                child.Layout(x, y, x + child.MeasuredWidth, y + child.MeasuredHeight);
                x += child.MeasuredWidth;
                rowHeight = System.Math.Max(rowHeight, child.MeasuredHeight);
            }
        }
    }
}
