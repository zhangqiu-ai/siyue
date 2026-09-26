/** Minimum readable two-column account frame in React Native points. */
export const accountSidebarWidth = 380;
export const accountDividerWidth = 1;
export const accountDetailMinWidth = 560;
export const splitMinWidth = accountSidebarWidth + accountDividerWidth + accountDetailMinWidth;

export const canSplitAccount = (width: number) => width >= splitMinWidth;
