export const homeListLimit = (win: Pick<Window, 'matchMedia'>) => win?.matchMedia?.('(max-width: 700px)').matches ? 1 : 2;
