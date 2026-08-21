const PET_ALPHA_FILTER_ID = 'tran-pet-alpha-clean'

/**
 * VP9 alpha may decode an otherwise transparent background as 1/255. Remove
 * only that codec floor while preserving 2/255+ antialiasing on thin legs,
 * shoes, hair, and dress edges.
 */
export const PET_ALPHA_FILTER_URL = `url(#${PET_ALPHA_FILTER_ID})`

export default function PetAlphaFilter(): JSX.Element {
  return (
    <svg width="0" height="0" aria-hidden style={{ position: 'absolute', pointerEvents: 'none' }}>
      <filter id={PET_ALPHA_FILTER_ID} colorInterpolationFilters="sRGB">
        <feComponentTransfer>
          <feFuncA type="linear" slope="1.004" intercept="-0.004" />
        </feComponentTransfer>
      </filter>
    </svg>
  )
}
